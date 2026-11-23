import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { NeonStoryRepository, NeonUploadLinkStore } from "@/lib/web/neon-repository";
import { StoryService } from "@/lib/web/story-service";
import {
  MemoryUploadLinkStore,
  openUploadLink,
  sealUploadLink,
  uploadLinkKey,
  uploadLinkLifetimeMs,
  UploadLinks,
} from "@/lib/web/upload-link";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://trips.example.com",
  pepper = ["upload", "link", "test", "pepper", "value", "long", "enough"].join("-"),
  storyInput = {
    title: "Kyoto in autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

async function fixture() {
  const repository = new MemoryStoryRepository(),
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit: 25 })
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    store = new MemoryUploadLinkStore(),
    clock = { now: new Date("2026-11-22T10:00:00.000Z") },
    links = new UploadLinks({ store, key: uploadLinkKey(pepper), now: () => clock.now }),
    server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner, publicOrigin: origin, uploadLinks: links }),
    client = new Client({ name: "upload-link-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { repository, stories, sessions, store, links, clock, client };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

function tokenOf(uploadUrl: unknown) {
  const match = /\/upload\/([A-Za-z0-9_-]+)$/.exec(String(uploadUrl));
  if (!match?.[1]) throw new Error(`not an upload URL: ${String(uploadUrl)}`);
  return match[1];
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01, REQ-WEB-03
describe("upload_photos one-time link (BUI-2095)", () => {
  it("BUI-2095 R1: returns uploadUrl, a 15-minute expiresAt and storyId, and records one upload_links row", async () => {
    const { stories, sessions, store, client } = await fixture(),
      story = await stories.createStory(await sessions.secretFor(owner), storyInput),
      result = await call(client, "upload_photos", { storyId: story.id });
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({
      storyId: story.id,
      uploadUrl: expect.stringMatching(/^https:\/\/trips\.example\.com\/upload\/[A-Za-z0-9_-]+$/),
      expiresAt: "2026-11-22T10:15:00.000Z",
    });
    const rows = store.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: expect.any(String), storyId: story.id, expiresAt: new Date("2026-11-22T10:15:00.000Z") });
    expect(uploadLinkLifetimeMs).toBe(15 * 60 * 1000);
  });

  it("BUI-2095 R2: refuses a story that is not uploading, by name, and creates no link", async () => {
    const { repository, stories, sessions, store, client } = await fixture(),
      story = await stories.createStory(await sessions.secretFor(owner), storyInput);
    await repository.saveStory({ ...story, status: "queued" }, story.version);
    const result = await call(client, "upload_photos", { storyId: story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("upload_photos");
    expect(result.text).toContain("Kyoto in autumn");
    expect(result.text).toContain("queued");
    expect(store.rows()).toHaveLength(0);
  });

  it("BUI-2095 R2: refuses another owner's story, by name, reveals nothing of it and creates no link", async () => {
    const { stories, store, client } = await fixture(),
      stranger = await stories.createSessionWithStory({ ...storyInput, title: "Someone else's trip" }, "client"),
      result = await call(client, "upload_photos", { storyId: stranger.story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("upload_photos");
    expect(result.text).not.toContain("Someone else");
    expect(store.rows()).toHaveLength(0);
  });

  it("BUI-2095 R3: the AES-256-GCM seal round-trips the link id, story id, expiry and owner session value", () => {
    const key = uploadLinkKey(pepper),
      claims = {
        linkId: "11111111-1111-4111-8111-111111111111",
        storyId: "22222222-2222-4222-8222-222222222222",
        expiresAt: new Date("2026-11-22T10:15:00.000Z"),
        ownerSecret: ["owner", "session", "value"].join("-"),
      },
      sealed = sealUploadLink(claims, key);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(claims.ownerSecret);
    expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain(claims.ownerSecret);
    expect(openUploadLink(sealed, key, new Date("2026-11-22T10:00:00.000Z"))).toEqual({ ok: true, claims });
    expect(key).toHaveLength(32);
    expect(uploadLinkKey(pepper).equals(key)).toBe(true);
    expect(uploadLinkKey(`${pepper}-other`).equals(key)).toBe(false);
  });

  it("BUI-2095 R3: a tampered, forged, other-key or expired token is refused", () => {
    const key = uploadLinkKey(pepper),
      claims = {
        linkId: "11111111-1111-4111-8111-111111111111",
        storyId: "22222222-2222-4222-8222-222222222222",
        expiresAt: new Date("2026-11-22T10:15:00.000Z"),
        ownerSecret: ["owner", "session", "value"].join("-"),
      },
      sealed = sealUploadLink(claims, key),
      bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
    const tampered = bytes.toString("base64url"),
      before = new Date("2026-11-22T10:00:00.000Z");
    expect(openUploadLink(tampered, key, before)).toEqual({ ok: false, reason: "invalid" });
    expect(openUploadLink(sealUploadLink(claims, uploadLinkKey(`${pepper}-other`)), key, before)).toEqual({ ok: false, reason: "invalid" });
    expect(openUploadLink("not a token!", key, before)).toEqual({ ok: false, reason: "invalid" });
    expect(openUploadLink("", key, before)).toEqual({ ok: false, reason: "invalid" });
    expect(openUploadLink("A".repeat(64), key, before)).toEqual({ ok: false, reason: "invalid" });
    expect(openUploadLink(sealed, key, new Date("2026-11-22T10:15:00.000Z"))).toEqual({ ok: false, reason: "expired" });
  });

  it("BUI-2095 R3, R5: UploadLinks opens an issued link once; a used or expired link no longer opens", async () => {
    const { stories, sessions, links, clock, client } = await fixture(),
      secret = await sessions.secretFor(owner),
      story = await stories.createStory(secret, storyInput),
      first = tokenOf((await call(client, "upload_photos", { storyId: story.id })).data?.uploadUrl),
      second = tokenOf((await call(client, "upload_photos", { storyId: story.id })).data?.uploadUrl),
      opened = await links.open(first);
    expect(opened).toMatchObject({ ok: true, claims: { storyId: story.id, ownerSecret: secret } });
    if (!opened.ok) throw new Error("expected an open link");
    expect(await links.use(opened.claims)).toBe(true);
    expect(await links.use(opened.claims)).toBe(false);
    expect(await links.open(first)).toEqual({ ok: false, reason: "used" });
    clock.now = new Date("2026-11-22T10:15:00.000Z");
    expect(await links.open(second)).toEqual({ ok: false, reason: "expired" });
  });

  it("BUI-2095 R3: a validly sealed token whose link row does not exist is refused", async () => {
    const { links, clock } = await fixture(),
      token = sealUploadLink(
        {
          linkId: "33333333-3333-4333-8333-333333333333",
          storyId: "22222222-2222-4222-8222-222222222222",
          expiresAt: new Date(clock.now.getTime() + 60_000),
          ownerSecret: ["owner", "session", "value"].join("-"),
        },
        uploadLinkKey(pepper)
      );
    expect(await links.open(token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("BUI-2095 R3: a token sealed under the right key for a real link but another story is refused", async () => {
    const { stories, sessions, store, links, clock } = await fixture(),
      secret = await sessions.secretFor(owner),
      story = await stories.createStory(secret, storyInput);
    await links.issue(story.id, secret);
    const token = sealUploadLink(
      {
        linkId: store.rows()[0]?.id ?? "",
        storyId: "44444444-4444-4444-8444-444444444444",
        expiresAt: new Date(clock.now.getTime() + 60_000),
        ownerSecret: secret,
      },
      uploadLinkKey(pepper)
    );
    expect(await links.open(token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("BUI-2095 R1: upload_photos on a server without an upload-link store fails and records nothing", async () => {
    const { stories, sessions } = await fixture(),
      server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner, publicOrigin: origin }),
      client = new Client({ name: "upload-link-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const story = await stories.createStory(await sessions.secretFor(owner), storyInput),
      result = await call(client, "upload_photos", { storyId: story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("upload-link store");
  });

  it("BUI-2095 R5: the Postgres store reads a row's expiry and used time", async () => {
    const rows = [
        { id: "link", story_id: "story", expires_at: new Date("2026-11-22T10:15:00Z"), used_at: "2026-11-22T10:05:00Z" },
        { id: "fresh", story_id: "story", expires_at: "2026-11-22T10:15:00Z", used_at: null },
      ],
      sql = (async (_parts: TemplateStringsArray, id: unknown) => rows.filter(row => row.id === id)) as unknown as NeonQueryFunction<
        false,
        false
      >,
      store = new NeonUploadLinkStore(sql);
    expect(await store.find("link")).toEqual({
      id: "link",
      storyId: "story",
      expiresAt: new Date("2026-11-22T10:15:00Z"),
      usedAt: new Date("2026-11-22T10:05:00Z"),
    });
    expect(await store.find("fresh")).toEqual({ id: "fresh", storyId: "story", expiresAt: new Date("2026-11-22T10:15:00Z") });
    expect(await store.find("missing")).toBeUndefined();
  });

  it("BUI-2095 R3: the upload_links row holds no secret: not the owner session value, its hash or the token", async () => {
    const { stories, sessions, store, client } = await fixture(),
      secret = await sessions.secretFor(owner),
      story = await stories.createStory(secret, storyInput),
      token = tokenOf((await call(client, "upload_photos", { storyId: story.id })).data?.uploadUrl),
      row = JSON.stringify(store.rows());
    expect(Object.keys(store.rows()[0] ?? {}).sort()).toEqual(["expiresAt", "id", "storyId"]);
    expect(row).not.toContain(secret);
    expect(row).not.toContain(`hash:${secret}`);
    expect(row).not.toContain(token);
  });

  it("BUI-2095 R1, R3, R5: the Postgres store inserts only id, story id and expiry, and uses a link in one conditional update", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [],
      sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ text: parts.join("?").replace(/\s+/g, " ").trim(), values });
        return statements.length === 2 ? [{ id: "link" }] : [];
      }) as unknown as NeonQueryFunction<false, false>,
      store = new NeonUploadLinkStore(sql),
      expiresAt = new Date("2026-11-22T10:15:00.000Z");
    await store.create({ id: "link", storyId: "story", expiresAt });
    expect(await store.use("link", "story", new Date("2026-11-22T10:00:00.000Z"))).toBe(true);
    expect(await store.use("link", "story", new Date("2026-11-22T10:00:00.000Z"))).toBe(false);
    expect(statements[0]).toEqual({
      text: "INSERT INTO upload_links (id, story_id, expires_at) VALUES (?, ?, ?)",
      values: ["link", "story", expiresAt],
    });
    expect(statements[1]?.text).toMatch(
      /^UPDATE upload_links SET used_at = now\(\) WHERE id = \? AND story_id = \? AND used_at IS NULL AND expires_at > now\(\) RETURNING id$/
    );
    expect(statements).toHaveLength(3);
  });

  it("BUI-2095 R1: migration 0008 creates upload_links with id, story id, expiry and used time, and purge removes a story's links", async () => {
    const { readFile } = await import("node:fs/promises"),
      migration = (await readFile("db/migrations/0008_upload_links.sql", "utf8")).replace(/\s+/g, " ");
    expect(migration).toMatch(/CREATE TABLE upload_links \(/);
    expect(migration).toMatch(/id uuid PRIMARY KEY/);
    expect(migration).toMatch(/story_id uuid NOT NULL REFERENCES stories\(id\)/);
    expect(migration).toMatch(/expires_at timestamptz NOT NULL/);
    expect(migration).toMatch(/used_at timestamptz[,\s)]/);
    expect(migration).not.toMatch(/secret|token|hash/i);
    let statement = "";
    const sql = (async (parts: TemplateStringsArray) => {
      statement = parts.join("?");
      return [{ count: 0 }];
    }) as unknown as NeonQueryFunction<false, false>;
    await new NeonStoryRepository(sql).purgeDeletedStories(new Date("2026-11-22T00:00:00Z"), 10);
    expect(statement).toContain("DELETE FROM upload_links WHERE story_id IN (SELECT id FROM doomed)");
  });
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("the skill's hosted workflow (BUI-2095)", () => {
  it("BUI-2095 R11: says create_story, then upload_photos, then open the link, then start_generation", async () => {
    const { readFile } = await import("node:fs/promises"),
      skill = await readFile("skills/wanderpage/SKILL.md", "utf8"),
      hosted = skill.slice(skill.indexOf("## Hosted stories")),
      steps = ["`create_story`", "`upload_photos`", "Open the link", "`start_generation`"].map(step => hosted.indexOf(step));
    expect(skill).toContain("## Hosted stories");
    expect(
      steps.every(index => index >= 0),
      steps.join()
    ).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });
});
