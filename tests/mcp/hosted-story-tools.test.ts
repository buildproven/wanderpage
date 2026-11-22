import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import type { TripManifest } from "@/lib/schemas/trip";
import { minStoryPhotos } from "@/lib/web/limits";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import type { Story } from "@/lib/web/types";
import { createHostedMcpHandler } from "@/app/api/mcp/_hosted/http";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://wander.test",
  storyInput = {
    title: "Kyoto in autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

async function fixture() {
  const repository = new MemoryStoryRepository(),
    policy = { enabled: true, dailyLimit: 25 },
    runner = { start: vi.fn(async () => ({ workflowRunId: "workflow" })) },
    stories = new StoryService(
      repository,
      runner,
      undefined,
      value => `hash:${value}`,
      () => policy,
      async () => undefined
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
      updateConsent: session => repository.createSession(session),
    }),
    cleanupStory = vi.fn(async (storyId: string) => void storyId),
    server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner, origin, cleanupStory }),
    client = new Client({ name: "hosted-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const ownerSecret = await sessions.secretFor(owner),
    stranger = await stories.createSessionWithStory({ ...storyInput, title: "Someone else's trip" }, "client");
  return { repository, policy, runner, stories, sessions, cleanupStory, client, ownerSecret, stranger: stranger.story };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

async function confirmUploads(repository: MemoryStoryRepository, story: Story, count = minStoryPhotos) {
  for (let index = 0; index < count; index += 1)
    await repository.createUpload({
      id: `${story.id}-upload-${index}`,
      storyId: story.id,
      blobPath: `sources/${story.id}/${index}.jpg`,
      originalName: `${index}.jpg`,
      declaredType: "image/jpeg",
      byteSize: 1000,
      status: "confirmed",
      createdAt: new Date(),
      confirmedAt: new Date(),
    });
}

function manifest(): TripManifest {
  return {
    schemaVersion: "1.0",
    generatedAt: "2026-11-01T00:00:00.000Z",
    published: false,
    title: "Kyoto in autumn",
    subtitle: "A private draft",
    opening: "An opening.",
    closing: "A closing.",
    peopleMode: "exclude",
    theme: { background: "#fff", foreground: "#111", accent: "#333", muted: "#666" },
    heroPhotoId: "photo-1",
    stats: [],
    destinations: [],
    route: [],
    chapters: [],
    photos: [
      {
        id: "photo-1",
        srcLarge: "/api/media/story/web-v1--run--large-0.webp",
        srcMedium: "/api/media/story/web-v1--run--medium-0.webp",
        srcThumb: "/api/media/story/web-v1--run--thumb-0.webp",
        width: 100,
        height: 100,
        alt: "Selected photograph",
        containsPeople: false,
        source: "user" as const,
      },
    ],
    sources: [],
  };
}

async function finishedDraft(repository: MemoryStoryRepository, story: Story) {
  return repository.saveStory({ ...story, status: "draft", manifest: manifest() }, story.version);
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01, REQ-WEB-02
describe("hosted MCP story tools that change a story (BUI-2100)", () => {
  it("BUI-2100: the hosted server lists the story tools that change a story", async () => {
    const { client } = await fixture(),
      { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(["create_story", "start_generation", "set_title", "publish", "unpublish", "delete_story"])
    );
  });

  it("BUI-2100 R1: create_story creates a story in the owner session with the current consent versions and returns its id", async () => {
    const { repository, stories, client, ownerSecret } = await fixture(),
      result = await call(client, "create_story", { title: "Porto at night", peopleMode: "include", locationPrivacy: "broad" });
    expect(result.isError).toBe(false);
    const id = String(result.data?.id),
      story = await stories.getOwnedStory(ownerSecret, id),
      session = await stories.requireSession(ownerSecret);
    expect(story).toMatchObject({ title: "Porto at night", peopleMode: "include", locationPrivacy: "broad", status: "uploading" });
    expect(session).toMatchObject({ termsVersion: currentDisclosureVersion, uploadConsentVersion: currentDisclosureVersion });
    expect(result.data).toMatchObject({ id, title: "Porto at night", status: "uploading", version: 0 });
    expect(result.text).not.toContain("admissionKey");
    expect((await repository.findStory(id))?.admissionKey).toBeTruthy();
  });

  it.each(["termsVersion", "uploadConsentVersion"] as const)(
    "BUI-2100 R1: create_story refreshes an owner session whose %s is stale",
    async staleField => {
      const { repository, stories, sessions, client, ownerSecret } = await fixture(),
        staleSession = await stories.requireSession(ownerSecret);
      await repository.createSession({
        ...staleSession,
        [staleField]: ["superseded", staleField].join("-"),
      });

      const result = await call(client, "create_story", {
          title: "Porto after the terms changed",
          peopleMode: "exclude",
          locationPrivacy: "hidden",
        }),
        refreshedSession = await stories.requireSession(await sessions.secretFor(owner));

      expect(result.isError).toBe(false);
      expect(refreshedSession).toMatchObject({
        id: staleSession.id,
        termsVersion: currentDisclosureVersion,
        uploadConsentVersion: currentDisclosureVersion,
      });
      expect(result.data).toMatchObject({ title: "Porto after the terms changed", status: "uploading" });
    }
  );

  it("BUI-2100 R4, R5: stale consent keeps an existing story listed and manageable", async () => {
    const { repository, stories, cleanupStory, client, ownerSecret } = await fixture(),
      draft = await finishedDraft(repository, await stories.createStory(ownerSecret, storyInput)),
      published = await stories.publish(ownerSecret, draft.id),
      staleSession = await stories.requireSession(ownerSecret);
    await repository.createSession({
      ...staleSession,
      termsVersion: ["superseded", "terms"].join("-"),
    });

    const created = await call(client, "create_story", {
        title: "A second trip",
        peopleMode: "exclude",
        locationPrivacy: "hidden",
      }),
      listed = await call(client, "list_stories", {}),
      unpublished = await call(client, "unpublish", { storyId: published.id });

    expect(created).toMatchObject({ isError: false, data: { title: "A second trip", status: "uploading" } });
    expect(listed.data?.stories).toEqual(expect.arrayContaining([expect.objectContaining({ id: published.id, status: "published" })]));
    expect(unpublished).toMatchObject({ isError: false, data: { id: published.id, status: "draft", published: false } });
    expect(await repository.findStory(published.id)).toMatchObject({ ownerSessionId: staleSession.id, status: "draft" });

    const deleted = await call(client, "delete_story", { storyId: published.id });
    expect(deleted).toMatchObject({ isError: false, data: { id: published.id, deletion: "started" } });
    expect(cleanupStory).toHaveBeenCalledExactlyOnceWith(published.id);
    expect(await repository.findStory(published.id)).toMatchObject({ ownerSessionId: staleSession.id, status: "deleting" });
  });

  it("BUI-2100 R1: create_story rejects an empty title and a privacy choice it does not know", async () => {
    const { client } = await fixture(),
      empty = await call(client, "create_story", { title: "  ", peopleMode: "exclude", locationPrivacy: "hidden" }),
      unknown = await call(client, "create_story", { title: "Trip", peopleMode: "exclude", locationPrivacy: "exact" });
    expect(empty.isError).toBe(true);
    expect(unknown.isError).toBe(true);
  });

  it("BUI-2100 R2: start_generation queues exactly one run for a story with confirmed uploads and reports the queued state", async () => {
    const { repository, runner, stories, client, ownerSecret } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput);
    await confirmUploads(repository, story);
    const first = await call(client, "start_generation", { storyId: story.id }),
      second = await call(client, "start_generation", { storyId: story.id });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ id: story.id, status: "queued" });
    expect(second).toMatchObject({ isError: true, text: "This story is already queued or cannot be generated." });
    expect(await repository.listRuns(story.id)).toHaveLength(1);
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("BUI-2100 R2: start_generation says so when generation is disabled and queues nothing", async () => {
    const { repository, policy, runner, stories, client, ownerSecret } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput);
    await confirmUploads(repository, story);
    policy.enabled = false;
    const result = await call(client, "start_generation", { storyId: story.id });
    expect(result).toMatchObject({ isError: true, text: "Story generation is temporarily unavailable." });
    expect(await repository.listRuns(story.id)).toHaveLength(0);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("BUI-2100 R2: start_generation refuses a story without enough confirmed uploads, and another owner's story", async () => {
    const { repository, runner, stories, client, ownerSecret, stranger } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput);
    await confirmUploads(repository, story, minStoryPhotos - 1);
    await confirmUploads(repository, stranger);
    const short = await call(client, "start_generation", { storyId: story.id }),
      foreign = await call(client, "start_generation", { storyId: stranger.id });
    expect(short).toMatchObject({ isError: true, text: `Add at least ${minStoryPhotos} completed photos before generating a story.` });
    expect(foreign).toMatchObject({ isError: true, text: "This story belongs to another private session." });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("BUI-2100 R3: set_title with the current version changes the title and returns the new version", async () => {
    const { stories, client, ownerSecret } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput),
      result = await call(client, "set_title", { storyId: story.id, version: story.version, title: "Kyoto, slowly" });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, title: "Kyoto, slowly", version: story.version + 1 });
    expect(await stories.getOwnedStory(ownerSecret, story.id)).toMatchObject({
      title: "Kyoto, slowly",
      peopleMode: storyInput.peopleMode,
      locationPrivacy: storyInput.locationPrivacy,
    });
  });

  it("BUI-2100 R3: set_title with a stale version reports the conflict and the current version, and changes nothing", async () => {
    const { stories, client, ownerSecret } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput),
      edited = await stories.updateStory(ownerSecret, story.id, story.version, { ...storyInput, title: "Edited elsewhere" }),
      result = await call(client, "set_title", { storyId: story.id, version: story.version, title: "Stale edit" });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ conflict: true, currentVersion: edited.version });
    expect(result.text).toContain(`current version is ${edited.version}`);
    expect((await stories.getOwnedStory(ownerSecret, story.id)).title).toBe("Edited elsewhere");
  });

  it("BUI-2100 R3: set_title refuses a published story with the reason and keeps its title", async () => {
    const { repository, stories, client, ownerSecret } = await fixture(),
      draft = await finishedDraft(repository, await stories.createStory(ownerSecret, storyInput)),
      published = await stories.publish(ownerSecret, draft.id),
      result = await call(client, "set_title", { storyId: draft.id, version: published.version, title: "Renamed live" });
    expect(result).toMatchObject({ isError: true, text: "This story cannot be edited while it is processing or published." });
    expect(await repository.findStory(draft.id)).toMatchObject({ title: "Kyoto in autumn", status: "published" });
  });

  it("BUI-2100 R3: set_title refuses another owner's story", async () => {
    const { repository, client, stranger } = await fixture(),
      result = await call(client, "set_title", { storyId: stranger.id, version: stranger.version, title: "Taken over" });
    expect(result).toMatchObject({ isError: true, text: "This story belongs to another private session." });
    expect(await repository.findStory(stranger.id)).toMatchObject({ title: "Someone else's trip", version: stranger.version });
  });

  it("BUI-2100 R4: publish changes only that story and returns its public URL; unpublish returns the unpublished state", async () => {
    const { repository, stories, client, ownerSecret } = await fixture(),
      chosen = await finishedDraft(repository, await stories.createStory(ownerSecret, storyInput)),
      other = await finishedDraft(repository, await stories.createStory(ownerSecret, { ...storyInput, title: "Other draft" })),
      published = await call(client, "publish", { storyId: chosen.id }),
      slug = (await repository.findStory(chosen.id))?.publicSlug;
    expect(published.isError).toBe(false);
    expect(slug).toBeTruthy();
    expect(published.data).toMatchObject({ id: chosen.id, status: "published", published: true, publicUrl: `${origin}/s/${slug}` });
    expect(await repository.findStory(other.id)).toMatchObject({ status: "draft", version: other.version });

    const unpublished = await call(client, "unpublish", { storyId: chosen.id });
    expect(unpublished.isError).toBe(false);
    expect(unpublished.data).toMatchObject({ id: chosen.id, status: "draft", published: false, publicUrl: null });
    expect(await repository.findStory(other.id)).toMatchObject({ status: "draft", version: other.version });
  });

  it("BUI-2100 R4: publish refuses a draft that is not final with the reason, and another owner's story", async () => {
    const { repository, stories, client, ownerSecret, stranger } = await fixture(),
      unfinished = await stories.createStory(ownerSecret, storyInput),
      foreignDraft = await finishedDraft(repository, stranger),
      refused = await call(client, "publish", { storyId: unfinished.id }),
      foreign = await call(client, "publish", { storyId: foreignDraft.id }),
      foreignUnpublish = await call(client, "unpublish", { storyId: foreignDraft.id });
    expect(refused).toMatchObject({ isError: true, text: "Finish a private draft before publishing." });
    expect(foreign).toMatchObject({ isError: true, text: "This story belongs to another private session." });
    expect(foreignUnpublish).toMatchObject({ isError: true, text: "This story belongs to another private session." });
    expect(await repository.findStory(unfinished.id)).toMatchObject({ status: "uploading" });
    expect(await repository.findStory(foreignDraft.id)).toMatchObject({ status: "draft" });
  });

  it("BUI-2100 R4: unpublish refuses a story that is not published", async () => {
    const { stories, client, ownerSecret } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput),
      result = await call(client, "unpublish", { storyId: story.id });
    expect(result).toMatchObject({ isError: true, text: "Only a published story can be unpublished." });
  });

  it("BUI-2100 R5: delete_story starts the existing deletion, removes the story's objects and confirms it", async () => {
    const { repository, stories, cleanupStory, client, ownerSecret } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput),
      result = await call(client, "delete_story", { storyId: story.id });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, deletion: "started" });
    expect(cleanupStory).toHaveBeenCalledExactlyOnceWith(story.id);
    expect(await repository.findStory(story.id)).toMatchObject({ status: "deleting" });
    expect(await stories.listOwnedStories(ownerSecret)).toHaveLength(0);
  });

  it("BUI-2100 R5: delete_story of a story already deleted confirms it without removing objects again", async () => {
    const { repository, stories, cleanupStory, client, ownerSecret } = await fixture(),
      story = await stories.createStory(ownerSecret, storyInput),
      deleting = await repository.beginDeleteStory(story.id, story.ownerSessionId, new Date(0));
    await repository.finishDeleteStory(deleting.id, new Date());
    const result = await call(client, "delete_story", { storyId: story.id });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, deletion: "already deleted" });
    expect(cleanupStory).not.toHaveBeenCalled();
  });

  it("BUI-2100 R5: delete_story refuses another owner's story and leaves it in place", async () => {
    const { repository, cleanupStory, client, stranger } = await fixture(),
      result = await call(client, "delete_story", { storyId: stranger.id });
    expect(result).toMatchObject({ isError: true, text: "Story not found." });
    expect(cleanupStory).not.toHaveBeenCalled();
    expect(await repository.findStory(stranger.id)).toMatchObject({ status: "uploading" });
  });

  it("BUI-2100: a server built for another subject refuses every tool that changes a story", async () => {
    const repository = new MemoryStoryRepository(),
      stories = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        undefined,
        value => `hash:${value}`,
        () => ({
          enabled: true,
          dailyLimit: 25,
        })
      ),
      sessions = new HostedOwnerSessions({
        service: stories,
        repository,
        bindings: new MemoryOwnerBindingStore(),
        key: "k".repeat(40),
        hashSecret: value => `hash:${value}`,
      }),
      cleanupStory = vi.fn(async (storyId: string) => void storyId),
      server = createHostedServer({ stories, sessions, subject: "someone-else", ownerSubject: owner, origin, cleanupStory }),
      client = new Client({ name: "hosted-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const storyId = "00000000-0000-4000-8000-000000000000",
      calls: Array<[string, Record<string, unknown>]> = [
        ["create_story", { title: "Trip", peopleMode: "exclude", locationPrivacy: "hidden" }],
        ["start_generation", { storyId }],
        ["set_title", { storyId, version: 0, title: "Trip" }],
        ["publish", { storyId }],
        ["unpublish", { storyId }],
        ["delete_story", { storyId }],
      ];
    for (const [name, args] of calls)
      expect(await call(client, name, args)).toMatchObject({ isError: true, text: expect.stringContaining("only its owner") });
    expect(cleanupStory).not.toHaveBeenCalled();
  });

  it("BUI-2100 R4: over HTTP, publish returns the public URL on the origin the owner called", async () => {
    const { repository, stories, sessions, ownerSecret } = await fixture(),
      draft = await finishedDraft(repository, await stories.createStory(ownerSecret, storyInput)),
      pair = await generateKeyPair("ES256"),
      keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256" }] }),
      bearer = await new SignJWT({ scope: "mcp", client_id: "client-1" })
        .setProtectedHeader({ alg: "ES256", kid: "test-key", typ: "at+jwt" })
        .setIssuer(origin)
        .setAudience(`${origin}/api/mcp`)
        .setSubject(owner)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(pair.privateKey),
      handle = createHostedMcpHandler({
        env: { WANDERPAGE_OAUTH_ISSUER: origin, WANDERPAGE_OAUTH_JWKS_URL: `${origin}/oauth/jwks`, WANDERPAGE_OWNER_SUBJECT: owner },
        keys,
        dependencies: () => ({ stories, sessions }),
      }),
      client = new Client({ name: "hosted-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        fetch: (input, init) => handle(new Request(input, init)),
      })
    );
    const result = await call(client, "publish", { storyId: draft.id }),
      slug = (await repository.findStory(draft.id))?.publicSlug;
    expect(result.data).toMatchObject({ status: "published", publicUrl: `${origin}/s/${slug}` });
    await client.close();
  });
});
