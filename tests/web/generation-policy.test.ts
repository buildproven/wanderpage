import { readFile } from "node:fs/promises";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { minStoryPhotos } from "@/lib/web/limits";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { StoryService, type GenerationPolicy } from "@/lib/web/story-service";
import type { OwnerSession } from "@/lib/web/types";
import { openUploadLink, sealUploadLink, uploadLinkKey } from "@/lib/web/upload-link";
import { UploadService } from "@/lib/web/upload-service";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";

const storyInput = {
    title: "Kyoto in autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  },
  photo = { originalName: "temple.jpg", contentType: "image/jpeg" as const, byteSize: 1024 },
  closedCreation = "Story creation is temporarily unavailable.",
  closedGeneration = "Story generation is temporarily unavailable.";

function fixture(policy: GenerationPolicy | undefined) {
  const repository = new MemoryStoryRepository(),
    started: string[] = [],
    stories = new StoryService(
      repository,
      {
        start: async (storyId: string) => {
          started.push(storyId);
          return { workflowRunId: `workflow-${started.length}` };
        },
      },
      undefined,
      value => `hash:${value}`,
      policy ? () => policy : undefined
    ),
    uploads = new UploadService(repository, stories, undefined, async () => "image/jpeg"),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    });
  return { repository, stories, uploads, sessions, started };
}

async function confirmUploads(repository: MemoryStoryRepository, storyId: string) {
  for (let index = 0; index < minStoryPhotos; index++)
    await repository.createUpload({
      id: crypto.randomUUID(),
      storyId,
      blobPath: `sources/${storyId}/confirmed-${index}`,
      originalName: `confirmed-${index}.jpg`,
      declaredType: "image/jpeg",
      byteSize: 1024,
      status: "confirmed",
      createdAt: new Date(),
      confirmedAt: new Date(),
    });
}

/**
 * Runs every hosted write step for `secret` against the prepared story (one reserved upload and enough confirmed photos), and records each
 * outcome so one refusal does not hide the next.
 */
async function attemptEveryStep(context: ReturnType<typeof fixture>, secret: string, storyId: string) {
  const { uploads } = context,
    reservation = (await context.repository.listUploads(storyId)).find(upload => upload.status === "reserved"),
    outcome = <T>(promise: Promise<T>) =>
      promise.then(
        value => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, message: error.message })
      );
  if (!reservation) throw new Error("the prepared story has no reserved upload");
  return {
    create: await outcome(context.stories.createStory(secret, storyInput, "client")),
    reserve: await outcome(uploads.reserve(secret, { storyId, ...photo })),
    authorize: await outcome(uploads.authorize(secret, JSON.parse(uploads.payload(reservation)), reservation.blobPath)),
    queue: await outcome(context.stories.queueGeneration(secret, storyId, "client")),
  };
}

/** Prepares one story with a reserved upload and enough confirmed photos while `policy` briefly admits everyone. */
async function prepare(context: ReturnType<typeof fixture>, policy: GenerationPolicy, secret: string) {
  const previous = policy.enabled;
  policy.enabled = true;
  const story = await context.stories.createStory(secret, storyInput, "client");
  await context.uploads.reserve(secret, { storyId: story.id, ...photo });
  await confirmUploads(context.repository, story.id);
  policy.enabled = previous;
  return story.id;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// @verifies DES-WEB-STORY, DES-WEB-UPLOAD, DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-09
describe("per-session generation policy (BUI-2136)", () => {
  it("BUI-2136 R2: with public creation off, an owner session creates, reserves, authorizes and queues", async () => {
    const policy = { enabled: false, ownerEnabled: true, dailyLimit: 25 },
      context = fixture(policy),
      secret = await context.sessions.secretFor("owner-login"),
      prepared = await prepare(context, policy, secret),
      result = await attemptEveryStep(context, secret, prepared);
    expect(result.create).toMatchObject({ ok: true });
    expect(result.reserve).toMatchObject({ ok: true });
    expect(result.authorize).toMatchObject({ ok: true });
    expect(result.queue).toMatchObject({ ok: true, value: { status: "queued" } });
    expect(context.started).toEqual([prepared]);
  });

  it("BUI-2136 R3: with public creation off, a public session is refused at every step", async () => {
    const policy = { enabled: false, ownerEnabled: true, dailyLimit: 25 },
      context = fixture(policy),
      { rawSecret } = await context.stories.createSession(storyInput),
      prepared = await prepare(context, policy, rawSecret),
      result = await attemptEveryStep(context, rawSecret, prepared);
    expect(result.create).toEqual({ ok: false, message: closedCreation });
    expect(result.reserve).toEqual({ ok: false, message: closedCreation });
    expect(result.authorize).toEqual({ ok: false, message: closedCreation });
    expect(result.queue).toEqual({ ok: false, message: closedGeneration });
    expect(await context.repository.listRuns(prepared)).toEqual([]);
    expect(context.started).toEqual([]);
  });

  it("BUI-2136 R3: with public creation off, the anonymous web creator cannot start a session with a story", async () => {
    const context = fixture({ enabled: false, ownerEnabled: true, dailyLimit: 25 });
    await expect(context.stories.createSessionWithStory(storyInput, "client")).rejects.toThrow(closedCreation);
  });

  it("BUI-2136 R2: with the owner switch off, the owner is refused at every step", async () => {
    const policy = { enabled: false, ownerEnabled: false, dailyLimit: 25 },
      context = fixture(policy),
      secret = await context.sessions.secretFor("owner-login"),
      prepared = await prepare(context, policy, secret),
      result = await attemptEveryStep(context, secret, prepared);
    expect(result.create).toEqual({ ok: false, message: closedCreation });
    expect(result.reserve).toEqual({ ok: false, message: closedCreation });
    expect(result.authorize).toEqual({ ok: false, message: closedCreation });
    expect(result.queue).toEqual({ ok: false, message: closedGeneration });
    expect(context.started).toEqual([]);
  });

  it("BUI-2136 R2: the daily generation limit still stops the owner", async () => {
    const policy = { enabled: false, ownerEnabled: true, dailyLimit: 1 },
      context = fixture(policy),
      secret = await context.sessions.secretFor("owner-login"),
      first = await context.stories.createStory(secret, storyInput, "client"),
      second = await context.stories.createStory(secret, storyInput, "client");
    await confirmUploads(context.repository, first.id);
    await confirmUploads(context.repository, second.id);
    await expect(context.stories.queueGeneration(secret, first.id, "client")).resolves.toMatchObject({ status: "queued" });
    await expect(context.stories.queueGeneration(secret, second.id, "client")).rejects.toThrow(
      "The story generation limit has been reached. Try again after the limit resets."
    );
    expect(context.started).toEqual([first.id]);
  });

  it("BUI-2136 R2: the per-session story limit still stops the owner", async () => {
    const context = fixture({ enabled: false, ownerEnabled: true, dailyLimit: 25 }),
      secret = await context.sessions.secretFor("owner-login");
    for (let index = 0; index < 3; index++) await context.stories.createStory(secret, storyInput, "client");
    await expect(context.stories.createStory(secret, storyInput, "client")).rejects.toThrow(
      "The private story creation limit has been reached. Try again after it resets."
    );
  });

  it("BUI-2136 R2: with public creation on, the owner is admitted even with the owner switch off", async () => {
    const context = fixture({ enabled: true, ownerEnabled: false, dailyLimit: 25 }),
      secret = await context.sessions.secretFor("owner-login");
    await expect(context.stories.createStory(secret, storyInput, "client")).resolves.toMatchObject({ status: "uploading" });
  });

  it("BUI-2136 R2: an injected policy without an owner switch keeps the owner with the public switch", async () => {
    const context = fixture({ enabled: false, dailyLimit: 25 }),
      secret = await context.sessions.secretFor("owner-login");
    await expect(context.stories.createStory(secret, storyInput, "client")).rejects.toThrow(closedCreation);
  });

  it("BUI-2136 R2: the environment admits the owner by default and refuses it when WANDERPAGE_OWNER_GENERATION_ENABLED=false", async () => {
    vi.stubEnv("WANDERPAGE_GENERATION_ENABLED", "false");
    vi.stubEnv("WANDERPAGE_DAILY_GENERATION_LIMIT", "25");
    vi.stubEnv("WANDERPAGE_OWNER_GENERATION_ENABLED", "");
    const context = fixture(undefined),
      secret = await context.sessions.secretFor("owner-login"),
      { rawSecret } = await context.stories.createSession(storyInput);
    await expect(context.stories.createStory(secret, storyInput, "client")).resolves.toMatchObject({ status: "uploading" });
    await expect(context.stories.createStory(rawSecret, storyInput, "client")).rejects.toThrow(closedCreation);
    vi.stubEnv("WANDERPAGE_OWNER_GENERATION_ENABLED", "true");
    await expect(context.stories.createStory(secret, storyInput, "client")).resolves.toMatchObject({ status: "uploading" });
    vi.stubEnv("WANDERPAGE_OWNER_GENERATION_ENABLED", "false");
    await expect(context.stories.createStory(secret, storyInput, "client")).rejects.toThrow(closedCreation);
  });

  it("BUI-2136 R2: the environment refuses an owner switch that is neither true nor false", async () => {
    vi.stubEnv("WANDERPAGE_GENERATION_ENABLED", "false");
    vi.stubEnv("WANDERPAGE_OWNER_GENERATION_ENABLED", "yes");
    const context = fixture(undefined),
      secret = await context.sessions.secretFor("owner-login");
    await expect(context.stories.createStory(secret, storyInput, "client")).rejects.toThrow(
      "WANDERPAGE_OWNER_GENERATION_ENABLED must be true or false when set."
    );
  });

  it("BUI-2136 R4: uploads through an upload link use the owner session it carries and are admitted", async () => {
    const policy = { enabled: false, ownerEnabled: true, dailyLimit: 25 },
      context = fixture(policy),
      secret = await context.sessions.secretFor("owner-login"),
      story = await context.stories.createStory(secret, storyInput, "client"),
      key = uploadLinkKey(["generation", "policy", "link", "pepper", "long", "enough"].join("-")),
      now = new Date(),
      sealed = sealUploadLink(
        { linkId: crypto.randomUUID(), storyId: story.id, expiresAt: new Date(now.getTime() + 60_000), ownerSecret: secret },
        key
      ),
      opened = openUploadLink(sealed, key, now);
    if (!opened.ok) throw new Error(`upload link did not open: ${opened.reason}`);
    const reserved = await context.uploads.reserve(opened.claims.ownerSecret, { storyId: story.id, ...photo });
    await expect(
      context.uploads.authorize(opened.claims.ownerSecret, JSON.parse(context.uploads.payload(reserved)), reserved.blobPath)
    ).resolves.toMatchObject({ id: reserved.id });
  });

  it("BUI-2136 R1: web sessions are recorded as public and hosted owner sessions as owner", async () => {
    const context = fixture({ enabled: true, ownerEnabled: true, dailyLimit: 25 }),
      web = await context.stories.createSession(storyInput),
      withStory = await context.stories.createSessionWithStory(storyInput, "client"),
      ownerSecret = await context.sessions.secretFor("owner-login");
    expect(web.session.kind).toBe("public");
    expect(withStory.session.kind).toBe("public");
    await expect(context.stories.requireSession(web.rawSecret)).resolves.toMatchObject({ kind: "public" });
    await expect(context.stories.requireSession(withStory.rawSecret)).resolves.toMatchObject({ kind: "public" });
    await expect(context.stories.requireSession(ownerSecret)).resolves.toMatchObject({ kind: "owner" });
  });

  it("BUI-2136 R1: the Neon repository writes and reads the session kind", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [],
      sessionRow = (kind: unknown) => ({
        id: "6a3b5f3e-6f0a-4a43-9a51-2d0f6e0b9c11",
        secret_hash: "hash",
        csrf_token: "csrf",
        created_at: new Date("2026-11-22T00:00:00Z"),
        last_seen_at: new Date("2026-11-22T00:00:00Z"),
        expires_at: new Date("2026-12-22T00:00:00Z"),
        revoked_at: null,
        terms_version: currentDisclosureVersion,
        upload_consent_version: currentDisclosureVersion,
        kind,
      });
    let returned: unknown[] = [];
    const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ text: parts.join("?").replace(/\s+/g, " ").trim(), values });
        return returned;
      }) as unknown as NeonQueryFunction<false, false>,
      repository = new NeonStoryRepository(sql),
      session: OwnerSession = {
        id: "6a3b5f3e-6f0a-4a43-9a51-2d0f6e0b9c11",
        secretHash: "hash",
        csrfToken: "csrf",
        createdAt: new Date("2026-11-22T00:00:00Z"),
        lastSeenAt: new Date("2026-11-22T00:00:00Z"),
        expiresAt: new Date("2026-12-22T00:00:00Z"),
        termsVersion: currentDisclosureVersion,
        uploadConsentVersion: currentDisclosureVersion,
        kind: "owner",
      };
    await repository.createSession(session);
    expect(statements[0]?.text).toMatch(/^INSERT INTO owner_sessions \([^)]*, kind\)/);
    expect(statements[0]?.values.at(-1)).toBe("owner");

    returned = [{ id: "story" }];
    await repository.createSessionAndStoryAdmitted(
      { ...session, kind: "public" },
      {
        id: "story",
        ownerSessionId: session.id,
        admissionKey: "client",
        status: "uploading",
        title: "Kyoto",
        peopleMode: "exclude",
        locationPrivacy: "approximate",
        processorRevision: "web-v1",
        sourceExpiresAt: new Date("2026-11-23T00:00:00Z"),
        createdAt: new Date("2026-11-22T00:00:00Z"),
        updatedAt: new Date("2026-11-22T00:00:00Z"),
        version: 0,
      },
      { sessionStories: 3, clientStories: 6, since: new Date("2026-11-21T00:00:00Z") }
    );
    expect(statements[1]?.text).toMatch(/INSERT INTO owner_sessions \([^)]*, kind\)/);
    expect(statements[1]?.values).toContain("public");

    returned = [sessionRow("owner")];
    await expect(repository.findSessionBySecretHash("hash")).resolves.toMatchObject({ kind: "owner" });
    returned = [sessionRow("public")];
    await expect(repository.renewSession("hash", new Date(), new Date())).resolves.toMatchObject({ kind: "public" });
    returned = [sessionRow("admin")];
    await expect(repository.findSessionBySecretHash("hash")).rejects.toThrow("owner_sessions.kind");
  });

  it("BUI-2136 R1: migration 0009 adds the kind column, defaults rows to public and marks bound sessions as owner", async () => {
    const migration = (await readFile("db/migrations/0009_session_kind.sql", "utf8")).replace(/\s+/g, " ");
    expect(migration).toMatch(/ALTER TABLE owner_sessions ADD COLUMN kind text NOT NULL DEFAULT 'public'/);
    expect(migration).toMatch(/CHECK \(kind IN \('public', 'owner'\)\)/);
    expect(migration).toMatch(/UPDATE owner_sessions SET kind = 'owner' WHERE id IN \(SELECT owner_session_id FROM mcp_owner_bindings\);/);
  });
});
