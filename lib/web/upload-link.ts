// @design DES-WEB-MCP
// One-time upload links (BUI-2095). A chat attachment never reaches the hosted connector, so `upload_photos` returns a link that opens
// the story's private page in the owner's browser. The token is sealed with AES-256-GCM and carries the owner session secret; the
// `upload_links` row holds only the link id, the story id, the expiry and the used time.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { UploadLink } from "@/lib/web/types";

/** How long an issued link can be used. */
export const uploadLinkLifetimeMs = 15 * 60 * 1000;
/** The lifetime, in seconds, of the owner cookie that a used link sets (not the 30 days of a web session). */
export const uploadLinkCookieMaxAge = 60 * 60;
/** The non-secret marker cookie that tells the proxy not to renew a link-set owner cookie. */
export const ownerTtlCookieName = "wanderpage_owner_ttl";
export const ownerTtlLinkValue = "link";

const version = 1,
  ivBytes = 12,
  tagBytes = 16,
  additionalData = Buffer.from("wanderpage-upload-link-v1"),
  tokenPattern = /^[A-Za-z0-9_-]{1,4096}$/;

const sealedSchema = z.strictObject({
  v: z.literal(version),
  l: z.uuid(),
  s: z.uuid(),
  e: z.number().int().positive(),
  k: z.string().min(1).max(512),
});

export type UploadLinkClaims = { linkId: string; storyId: string; expiresAt: Date; ownerSecret: string };
export type OpenedUploadLink = { ok: true; claims: UploadLinkClaims } | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * The 32-byte AES key, derived from `WANDERPAGE_SESSION_PEPPER` under the label `upload-link` (HMAC key separation, as `mcpSessionKey`),
 * so links need no extra secret. Rotating the pepper voids every open link, as it already ends every owner session.
 */
export function uploadLinkKey(pepper: string) {
  if (!pepper) throw new Error("WANDERPAGE_SESSION_PEPPER is required for upload links.");
  return createHmac("sha256", pepper).update("wanderpage-upload-link-key-v1").digest();
}

export function sealUploadLink(claims: UploadLinkClaims, key: Buffer) {
  const iv = randomBytes(ivBytes),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  const plain = JSON.stringify({ v: version, l: claims.linkId, s: claims.storyId, e: claims.expiresAt.getTime(), k: claims.ownerSecret }),
    sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
}

/** Opens a sealed token: `invalid` for anything forged, tampered with or malformed, `expired` at or after its expiry. */
export function openUploadLink(token: string, key: Buffer, now: Date): OpenedUploadLink {
  if (!tokenPattern.test(token)) return { ok: false, reason: "invalid" };
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length <= ivBytes + tagBytes || bytes.toString("base64url") !== token) return { ok: false, reason: "invalid" };
  let plain: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, ivBytes));
    decipher.setAAD(additionalData);
    decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
    plain = Buffer.concat([decipher.update(bytes.subarray(ivBytes, bytes.length - tagBytes)), decipher.final()]).toString("utf8");
  } catch {
    // GCM authentication failed: the token was not sealed under this key, or was changed.
    return { ok: false, reason: "invalid" };
  }
  const parsed = sealedSchema.safeParse(parseJson(plain));
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const claims = { linkId: parsed.data.l, storyId: parsed.data.s, expiresAt: new Date(parsed.data.e), ownerSecret: parsed.data.k };
  if (claims.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export type UploadLinkStore = {
  create(link: Omit<UploadLink, "usedAt">): Promise<void>;
  find(id: string): Promise<UploadLink | undefined>;
  /** Marks the link used only while it is unused and unexpired, in one conditional write; true when this call used it. */
  use(id: string, storyId: string, now: Date): Promise<boolean>;
};

export type UploadLinksOptions = {
  store: UploadLinkStore;
  /** `uploadLinkKey` of the session pepper in production. */
  key: Buffer;
  now?: () => Date;
  newId?: () => string;
};

export class UploadLinks {
  constructor(private readonly options: UploadLinksOptions) {
    if (options.key.length !== 32) throw new Error("The upload-link key must be 32 bytes.");
  }

  /** Records one link row for the story and returns its sealed token and expiry. */
  async issue(storyId: string, ownerSecret: string) {
    const id = (this.options.newId ?? randomUUID)(),
      expiresAt = new Date(this.now().getTime() + uploadLinkLifetimeMs);
    await this.options.store.create({ id, storyId, expiresAt });
    return { token: sealUploadLink({ linkId: id, storyId, expiresAt, ownerSecret }, this.options.key), expiresAt };
  }

  /** Opens a token without using it: the seal, its expiry and the row, which must exist for that story, be unused and unexpired. */
  async open(token: string): Promise<OpenedUploadLink> {
    const now = this.now(),
      opened = openUploadLink(token, this.options.key, now);
    if (!opened.ok) return opened;
    const link = await this.options.store.find(opened.claims.linkId);
    if (!link || link.storyId !== opened.claims.storyId) return { ok: false, reason: "invalid" };
    if (link.usedAt) return { ok: false, reason: "used" };
    if (link.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
    return opened;
  }

  /** Uses an opened link once; false when it was already used or has expired since it was opened. */
  use(claims: UploadLinkClaims) {
    return this.options.store.use(claims.linkId, claims.storyId, this.now());
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }
}

/** Process-local links, for tests. */
export class MemoryUploadLinkStore implements UploadLinkStore {
  private readonly links = new Map<string, UploadLink>();

  async create(link: Omit<UploadLink, "usedAt">) {
    if (this.links.has(link.id)) throw new Error("UPLOAD_LINK_EXISTS");
    this.links.set(link.id, { ...link });
  }

  async find(id: string) {
    const link = this.links.get(id);
    return link ? { ...link } : undefined;
  }

  async use(id: string, storyId: string, now: Date) {
    const link = this.links.get(id);
    if (!link || link.storyId !== storyId || link.usedAt || link.expiresAt.getTime() <= now.getTime()) return false;
    link.usedAt = now;
    return true;
  }

  /** Every stored row, as the database would hold it. */
  rows() {
    return [...this.links.values()].map(link => ({ ...link }));
  }
}
