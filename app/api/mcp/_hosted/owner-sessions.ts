// @design DES-WEB-MCP
// Binds the signed-in owner's OAuth subject to one hosted owner session (BUI-2099). StoryService authorizes every read by an owner
// session secret; the MCP owner has no cookie, so the secret is derived from a server key, the subject and the bound session id, and is
// never stored or sent. The binding table holds only a keyed hash of the subject and the session id.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { currentDisclosureVersion } from "@/lib/consent";
import { StoryServiceError, type StoryService } from "@/lib/web/story-service";
import type { StoryRepository } from "@/lib/web/types";

/** Shortest accepted owner-session key, in characters. */
export const minimumSessionKeyLength = 32;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

export type OwnerBindingStore = {
  /** The owner session id bound to the subject key, if any. */
  find(subjectKey: string): Promise<string | undefined>;
  /**
   * Binds `sessionId` only while the current binding is `expected` (undefined: no binding yet), then resolves the binding that holds,
   * which is another request's session when that request bound first.
   */
  bind(subjectKey: string, sessionId: string, expected: string | undefined, now: Date): Promise<string | undefined>;
};

export type OwnerSessionsOptions = {
  service: Pick<StoryService, "requireSession">;
  repository: Pick<StoryRepository, "createSession">;
  bindings: OwnerBindingStore;
  /** Derives the session secret and the subject hash (`mcpSessionKey` of the session pepper in production). */
  key: string;
  /** The same hash StoryService applies to an owner session secret. */
  hashSecret: (secret: string) => string;
  now?: () => Date;
  newSessionId?: () => string;
};

export class HostedOwnerSessions {
  constructor(private readonly options: OwnerSessionsOptions) {
    if (options.key.length < minimumSessionKeyLength)
      throw new Error(`The owner-session key must be at least ${minimumSessionKeyLength} characters.`);
  }

  /**
   * The owner session secret for `subject`. The first call creates an owner session with the current consent versions and binds it;
   * later calls reuse it while StoryService accepts it, and bind a new one once retention has expired, revoked or purged it.
   */
  async secretFor(subject: string) {
    if (!subject) throw new StoryServiceError("AUTH_REQUIRED", "The access token names no owner.");
    const subjectKey = this.derive("subject", subject),
      bound = await this.options.bindings.find(subjectKey);
    if (bound) {
      const secret = this.derive("session", subject, bound);
      if (await this.live(secret)) return secret;
    }
    const sessionId = (this.options.newSessionId ?? randomUUID)(),
      secret = this.derive("session", subject, sessionId),
      now = this.options.now?.() ?? new Date();
    await this.options.repository.createSession({
      id: sessionId,
      secretHash: this.options.hashSecret(secret),
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + sessionLifetimeMs),
      termsVersion: currentDisclosureVersion,
      uploadConsentVersion: currentDisclosureVersion,
    });
    const winner = await this.options.bindings.bind(subjectKey, sessionId, bound, now);
    if (winner === sessionId) return secret;
    if (winner) {
      const other = this.derive("session", subject, winner);
      if (await this.live(other)) return other;
    }
    throw new Error("Wanderpage could not bind the owner session for this sign-in. Try the request again.");
  }

  private async live(secret: string) {
    try {
      await this.options.service.requireSession(secret);
      return true;
    } catch (error) {
      if (error instanceof StoryServiceError && error.code === "AUTH_REQUIRED") return false;
      throw error;
    }
  }

  private derive(purpose: "session" | "subject", ...parts: string[]) {
    return createHmac("sha256", this.options.key)
      .update(["wanderpage-mcp", purpose, ...parts].join("\0"))
      .digest("base64url");
  }
}

/** Process-local bindings, for tests. */
export class MemoryOwnerBindingStore implements OwnerBindingStore {
  private readonly bindings = new Map<string, string>();

  async find(subjectKey: string) {
    return this.bindings.get(subjectKey);
  }

  async bind(subjectKey: string, sessionId: string, expected: string | undefined) {
    if (this.bindings.get(subjectKey) === expected) this.bindings.set(subjectKey, sessionId);
    return this.bindings.get(subjectKey);
  }
}

/** Bindings in the `mcp_owner_bindings` table (migration 0007), shared by every serverless instance. */
export class PostgresOwnerBindingStore implements OwnerBindingStore {
  constructor(private readonly sql: NeonQueryFunction<false, false>) {}

  async find(subjectKey: string) {
    const [row] = await this.sql`SELECT owner_session_id FROM mcp_owner_bindings WHERE subject_hash = ${subjectKey}`;
    return row ? String(row.owner_session_id) : undefined;
  }

  async bind(subjectKey: string, sessionId: string, expected: string | undefined, now: Date) {
    if (expected === undefined)
      await this.sql`
        INSERT INTO mcp_owner_bindings (subject_hash, owner_session_id, bound_at) VALUES (${subjectKey}, ${sessionId}, ${now})
        ON CONFLICT (subject_hash) DO NOTHING
      `;
    else
      await this.sql`
        UPDATE mcp_owner_bindings SET owner_session_id = ${sessionId}, bound_at = ${now}
        WHERE subject_hash = ${subjectKey} AND owner_session_id = ${expected}
      `;
    return this.find(subjectKey);
  }
}
