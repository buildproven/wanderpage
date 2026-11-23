import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import {
  DownloadLinks,
  downloadLinkKey,
  downloadLinkLifetimeMs,
  MemoryDownloadLinkStore,
  openDownloadLink,
  sealDownloadLink,
} from "@/lib/web/download-link";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { NeonDownloadLinkStore, NeonStoryRepository } from "@/lib/web/neon-repository";
import { StoryService } from "@/lib/web/story-service";
import { sealUploadLink, uploadLinkKey } from "@/lib/web/upload-link";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://trips.example.com",
  pepper = ["download", "link", "test", "pepper", "value", "long", "enough"].join("-"),
  storyInput = {
    title: "Kyoto in autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

async function fixture(withLinks = true) {
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
    store = new MemoryDownloadLinkStore(),
    clock = { now: new Date("2026-11-23T10:00:00.000Z") },
    links = new DownloadLinks({ store, key: downloadLinkKey(pepper), now: () => clock.now }),
    server = createHostedServer({
      stories,
      sessions,
      subject: owner,
      ownerSubject: owner,
      publicOrigin: origin,
      ...(withLinks ? { downloadLinks: links } : {}),
    }),
    client = new Client({ name: "download-link-test", version: "1.0.0" }),
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

function tokenOf(downloadUrl: unknown) {
  const match = /\/download\/([A-Za-z0-9_-]+)$/.exec(String(downloadUrl));
  if (!match?.[1]) throw new Error(`not a download URL: ${String(downloadUrl)}`);
  return match[1];
}

const claims = {
  linkId: "11111111-1111-4111-8111-111111111111",
  storyId: "22222222-2222-4222-8222-222222222222",
  expiresAt: new Date("2026-11-23T10:15:00.000Z"),
  ownerSecret: ["owner", "session", "value"].join("-"),
};

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01, REQ-WEB-03
describe("download_page one-time link (BUI-2146)", () => {
  it.each(["draft", "published"] as const)(
    "BUI-2146 R1: a %s story returns downloadUrl, a 15-minute expiresAt and records one download_links row",
    async status => {
      const { repository, stories, sessions, store, client } = await fixture(),
        story = await stories.createStory(await sessions.secretFor(owner), storyInput);
      await repository.saveStory({ ...story, status }, story.version);
      const result = await call(client, "download_page", { storyId: story.id });
      expect(result.isError).toBe(false);
      expect(result.data).toEqual({
        storyId: story.id,
        downloadUrl: expect.stringMatching(/^https:\/\/trips\.example\.com\/download\/[A-Za-z0-9_-]+$/),
        expiresAt: "2026-11-23T10:15:00.000Z",
      });
      expect(store.rows()).toEqual([{ id: expect.any(String), storyId: story.id, expiresAt: new Date("2026-11-23T10:15:00.000Z") }]);
      expect(downloadLinkLifetimeMs).toBe(15 * 60 * 1000);
    }
  );

  it.each(["uploading", "queued", "processing", "failed"] as const)(
    "BUI-2146 R2: a %s story is refused by tool and story name and creates no link",
    async status => {
      const { repository, stories, sessions, store, client } = await fixture(),
        story = await stories.createStory(await sessions.secretFor(owner), storyInput);
      await repository.saveStory({ ...story, status }, story.version);
      const result = await call(client, "download_page", { storyId: story.id });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("download_page");
      expect(result.text).toContain("Kyoto in autumn");
      expect(result.text).toContain(status);
      expect(store.rows()).toHaveLength(0);
    }
  );

  it("BUI-2146 R2: another owner's story is refused by name, reveals nothing of it and creates no link", async () => {
    const { stories, store, client } = await fixture(),
      stranger = await stories.createSessionWithStory({ ...storyInput, title: "Someone else's trip" }, "client"),
      result = await call(client, "download_page", { storyId: stranger.story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("download_page");
    expect(result.text).not.toContain("Someone else");
    expect(store.rows()).toHaveLength(0);
  });

  it("BUI-2146 R2: a story that does not exist is refused and creates no link", async () => {
    const { store, client } = await fixture(),
      result = await call(client, "download_page", { storyId: "33333333-3333-4333-8333-333333333333" });
    expect(result.isError).toBe(true);
    expect(store.rows()).toHaveLength(0);
  });

  it("BUI-2146 R1: a server without a download-link store fails and records nothing", async () => {
    const { stories, sessions, repository, client } = await fixture(false),
      story = await stories.createStory(await sessions.secretFor(owner), storyInput);
    await repository.saveStory({ ...story, status: "draft" }, story.version);
    const result = await call(client, "download_page", { storyId: story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("download-link store");
  });

  it("BUI-2146 R1: the seal round-trips the claims and holds no plain owner session value", () => {
    const key = downloadLinkKey(pepper),
      sealed = sealDownloadLink(claims, key);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain(claims.ownerSecret);
    expect(openDownloadLink(sealed, key, new Date("2026-11-23T10:00:00.000Z"))).toEqual({ ok: true, claims });
    expect(key).toHaveLength(32);
  });

  it("BUI-2146 R1: the download-link key is its own label: it differs from the upload-link key", () => {
    expect(downloadLinkKey(pepper).equals(uploadLinkKey(pepper))).toBe(false);
    expect(downloadLinkKey(pepper).equals(downloadLinkKey(pepper))).toBe(true);
    expect(() => downloadLinkKey("")).toThrow(/WANDERPAGE_SESSION_PEPPER/);
  });

  it("BUI-2146 R1: an upload-link token never opens as a download link", () => {
    const upload = sealUploadLink(claims, uploadLinkKey(pepper));
    expect(openDownloadLink(upload, downloadLinkKey(pepper), new Date("2026-11-23T10:00:00.000Z"))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("BUI-2146 R5: a tampered, forged, other-key, malformed or expired token is refused", () => {
    const key = downloadLinkKey(pepper),
      sealed = sealDownloadLink(claims, key),
      bytes = Buffer.from(sealed, "base64url"),
      before = new Date("2026-11-23T10:00:00.000Z");
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
    expect(openDownloadLink(bytes.toString("base64url"), key, before)).toEqual({ ok: false, reason: "invalid" });
    expect(openDownloadLink(sealDownloadLink(claims, downloadLinkKey(`${pepper}-other`)), key, before)).toEqual({
      ok: false,
      reason: "invalid",
    });
    for (const bad of ["not a token!", "", "A".repeat(64), "A".repeat(5000)])
      expect(openDownloadLink(bad, key, before)).toEqual({ ok: false, reason: "invalid" });
    expect(openDownloadLink(sealed, key, new Date("2026-11-23T10:15:00.000Z"))).toEqual({ ok: false, reason: "expired" });
  });

  it("BUI-2146 R5: DownloadLinks opens an issued link once; a used or expired link no longer opens", async () => {
    const { stories, sessions, repository, links, clock, client } = await fixture(),
      secret = await sessions.secretFor(owner),
      story = await stories.createStory(secret, storyInput);
    await repository.saveStory({ ...story, status: "draft" }, story.version);
    const first = tokenOf((await call(client, "download_page", { storyId: story.id })).data?.downloadUrl),
      second = tokenOf((await call(client, "download_page", { storyId: story.id })).data?.downloadUrl),
      opened = await links.open(first);
    expect(opened).toMatchObject({ ok: true, claims: { storyId: story.id, ownerSecret: secret } });
    if (!opened.ok) throw new Error("expected an open link");
    expect(await links.use(opened.claims)).toBe(true);
    expect(await links.use(opened.claims)).toBe(false);
    expect(await links.open(first)).toEqual({ ok: false, reason: "used" });
    clock.now = new Date("2026-11-23T10:15:00.000Z");
    expect(await links.open(second)).toEqual({ ok: false, reason: "expired" });
  });

  it("BUI-2146 R5: a validly sealed token with no link row, or a row of another story, is refused", async () => {
    const { stories, sessions, store, links, clock } = await fixture(),
      secret = await sessions.secretFor(owner),
      story = await stories.createStory(secret, storyInput),
      key = downloadLinkKey(pepper),
      expiresAt = new Date(clock.now.getTime() + 60_000);
    expect(await links.open(sealDownloadLink({ ...claims, expiresAt }, key))).toEqual({ ok: false, reason: "invalid" });
    await links.issue(story.id, secret);
    const wrongStory = sealDownloadLink(
      { linkId: store.rows()[0]?.id ?? "", storyId: "44444444-4444-4444-8444-444444444444", expiresAt, ownerSecret: secret },
      key
    );
    expect(await links.open(wrongStory)).toEqual({ ok: false, reason: "invalid" });
  });

  it("BUI-2146 R1: the download_links row holds no secret: not the owner session value, its hash or the token", async () => {
    const { stories, sessions, repository, store, client } = await fixture(),
      secret = await sessions.secretFor(owner),
      story = await stories.createStory(secret, storyInput);
    await repository.saveStory({ ...story, status: "draft" }, story.version);
    const token = tokenOf((await call(client, "download_page", { storyId: story.id })).data?.downloadUrl),
      row = JSON.stringify(store.rows());
    expect(Object.keys(store.rows()[0] ?? {}).sort()).toEqual(["expiresAt", "id", "storyId"]);
    expect(row).not.toContain(secret);
    expect(row).not.toContain(`hash:${secret}`);
    expect(row).not.toContain(token);
  });

  it("BUI-2146 R1, R4: the Postgres store inserts only id, story id and expiry, and uses a link in one conditional update", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [],
      sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ text: parts.join("?").replace(/\s+/g, " ").trim(), values });
        return statements.length === 2 ? [{ id: "link" }] : [];
      }) as unknown as NeonQueryFunction<false, false>,
      store = new NeonDownloadLinkStore(sql),
      expiresAt = new Date("2026-11-23T10:15:00.000Z");
    await store.create({ id: "link", storyId: "story", expiresAt });
    expect(await store.use("link", "story", new Date("2026-11-23T10:00:00.000Z"))).toBe(true);
    expect(await store.use("link", "story", new Date("2026-11-23T10:00:00.000Z"))).toBe(false);
    expect(statements[0]).toEqual({
      text: "INSERT INTO download_links (id, story_id, expires_at) VALUES (?, ?, ?)",
      values: ["link", "story", expiresAt],
    });
    expect(statements[1]?.text).toMatch(
      /^UPDATE download_links SET used_at = now\(\) WHERE id = \? AND story_id = \? AND used_at IS NULL AND expires_at > now\(\) RETURNING id$/
    );
  });

  it("BUI-2146 R5: the Postgres store reads a row's expiry and used time", async () => {
    const rows = [
        { id: "link", story_id: "story", expires_at: new Date("2026-11-23T10:15:00Z"), used_at: "2026-11-23T10:05:00Z" },
        { id: "fresh", story_id: "story", expires_at: "2026-11-23T10:15:00Z", used_at: null },
      ],
      sql = (async (_parts: TemplateStringsArray, id: unknown) => rows.filter(row => row.id === id)) as unknown as NeonQueryFunction<
        false,
        false
      >,
      store = new NeonDownloadLinkStore(sql);
    expect(await store.find("link")).toEqual({
      id: "link",
      storyId: "story",
      expiresAt: new Date("2026-11-23T10:15:00Z"),
      usedAt: new Date("2026-11-23T10:05:00Z"),
    });
    expect(await store.find("fresh")).toEqual({ id: "fresh", storyId: "story", expiresAt: new Date("2026-11-23T10:15:00Z") });
    expect(await store.find("missing")).toBeUndefined();
  });

  it("BUI-2146 R1: migration 0010 creates download_links, and the purge removes a story's download links", async () => {
    const migration = (await readFile("db/migrations/0010_download_links.sql", "utf8")).replace(/\s+/g, " ");
    expect(migration).toMatch(/CREATE TABLE download_links \(/);
    expect(migration).toMatch(/id uuid PRIMARY KEY/);
    expect(migration).toMatch(/story_id uuid NOT NULL REFERENCES stories\(id\)/);
    expect(migration).toMatch(/expires_at timestamptz NOT NULL/);
    expect(migration).toMatch(/used_at timestamptz[,\s)]/);
    expect(migration).toMatch(/CREATE INDEX download_links_story_id_idx ON download_links \(story_id\)/);
    expect(migration).not.toMatch(/secret|token|hash/i);
    let statement = "";
    const sql = (async (parts: TemplateStringsArray) => {
      statement = parts.join("?");
      return [{ count: 0 }];
    }) as unknown as NeonQueryFunction<false, false>;
    await new NeonStoryRepository(sql).purgeDeletedStories(new Date("2026-11-23T00:00:00Z"), 10);
    expect(statement).toContain("DELETE FROM download_links WHERE story_id IN (SELECT id FROM doomed)");
    expect(statement).toContain("DELETE FROM upload_links WHERE story_id IN (SELECT id FROM doomed)");
  });
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("the skill offers download_page (BUI-2146)", () => {
  it("BUI-2146 R6: the hosted workflow offers download_page after start_generation, when the draft is ready", async () => {
    const skill = await readFile("skills/wanderpage/SKILL.md", "utf8"),
      description = /^description: (.*)$/m.exec(skill)?.[1] ?? "",
      hosted = skill.slice(skill.indexOf("## Hosted stories")),
      generation = hosted.indexOf("`start_generation`"),
      download = hosted.indexOf("`download_page`");
    expect(description).toContain("download_page");
    expect(generation).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(generation);
    expect(hosted.replace(/\s+/g, " ")).toMatch(/download_page.{0,400}(zip|ZIP)/);
  });
});
