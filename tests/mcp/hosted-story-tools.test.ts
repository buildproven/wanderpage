import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import type { TripManifest } from "@/lib/schemas/trip";
import { minStoryPhotos } from "@/lib/web/limits";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { curationRevision, StoryService, type CurationMedia } from "@/lib/web/story-service";
import type { Story } from "@/lib/web/types";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://trips.example.com",
  storyInput = {
    title: "Kyoto in autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

let photo: Buffer;

beforeAll(async () => {
  photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#6b8fa3" } })
    .jpeg()
    .toBuffer();
});

/** Every confirmed upload reads as the same small JPEG, so save_curation can build a page from any of them. */
const media: CurationMedia = { read: async () => photo, write: async () => undefined };

async function fixture(subject = owner) {
  const repository = new MemoryStoryRepository(),
    policy = { enabled: true, dailyLimit: 25 },
    started: string[] = [],
    removed: string[] = [],
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
      () => policy,
      async () => undefined,
      media
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    server = createHostedServer({
      stories,
      sessions,
      subject,
      ownerSubject: owner,
      publicOrigin: origin,
      removeObjects: async storyId => {
        removed.push(storyId);
      },
    }),
    client = new Client({ name: "hosted-tools-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { repository, stories, sessions, client, policy, started, removed };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

async function ownerStory({ stories, sessions }: Fixture, title = storyInput.title) {
  return stories.createStory(await sessions.secretFor(owner), { ...storyInput, title });
}

async function strangerStory({ stories }: Fixture) {
  return (await stories.createSessionWithStory({ ...storyInput, title: "Someone else's trip" }, "client")).story;
}

async function confirmUploads({ repository }: Fixture, storyId: string, count = minStoryPhotos) {
  for (let index = 0; index < count; index += 1)
    await repository.createUpload({
      id: `${storyId}-upload-${index}`,
      storyId,
      blobPath: `sources/${storyId}/${index}.jpg`,
      originalName: `${index}.jpg`,
      declaredType: "image/jpeg",
      status: "confirmed",
      createdAt: new Date(),
      confirmedAt: new Date(),
    });
}

/** Claude's curation of the first two confirmed uploads, as `save_curation` takes it. */
const curation = (storyId: string) => ({
  storyId,
  title: "Kyoto in autumn",
  intro: "Maple light along the river.",
  namesNoPerson: true,
  photos: [0, 1].map(index => ({
    photoId: `${storyId}-upload-${index}`,
    caption: "A temple roof under red leaves.",
    containsPeople: false,
  })),
});

async function asDraft({ repository }: Fixture, story: Story) {
  return repository.saveStory({ ...story, status: "draft", manifest: manifest(story.title) }, story.version);
}

function manifest(title: string): TripManifest {
  return {
    schemaVersion: "1.0",
    generatedAt: "2026-11-01T00:00:00.000Z",
    published: false,
    title,
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
        source: "user",
      },
    ],
    sources: [],
  };
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("hosted MCP story tools (BUI-2100)", () => {
  it("BUI-2100 R1: create_story creates a story in the owner session with the current consent versions and returns its id", async () => {
    const context = await fixture(),
      result = await call(context.client, "create_story", { title: "Lisbon by tram", peopleMode: "include", locationPrivacy: "broad" });
    expect(result.isError).toBe(false);
    const id = result.data?.id as string,
      ownerSecret = await context.sessions.secretFor(owner),
      session = await context.stories.requireSession(ownerSecret),
      story = await context.stories.getOwnedStory(ownerSecret, id);
    expect(story).toMatchObject({ title: "Lisbon by tram", peopleMode: "include", locationPrivacy: "broad", status: "uploading" });
    expect(story.ownerSessionId).toBe(session.id);
    expect(session).toMatchObject({ termsVersion: currentDisclosureVersion, uploadConsentVersion: currentDisclosureVersion });
    expect(result.data).toMatchObject({ id, title: "Lisbon by tram", status: "uploading", version: 0 });
    expect(result.text).not.toContain("ownerSessionId");
    expect(result.text).not.toContain("admissionKey");
  });

  it("BUI-2100 R1: create_story rejects an unknown people choice and a blank title, and creates nothing", async () => {
    const context = await fixture(),
      badPeople = await call(context.client, "create_story", { title: "Trip", peopleMode: "everyone", locationPrivacy: "broad" }),
      blank = await call(context.client, "create_story", { title: "   ", peopleMode: "exclude", locationPrivacy: "hidden" });
    expect(badPeople.isError).toBe(true);
    expect(blank.isError).toBe(true);
    expect(await context.stories.listOwnedStories(await context.sessions.secretFor(owner))).toEqual([]);
  });

  it("BUI-2100 R1: create_story is refused for a token of another subject", async () => {
    const context = await fixture("someone-else"),
      result = await call(context.client, "create_story", { title: "Trip", peopleMode: "exclude", locationPrivacy: "hidden" });
    expect(result).toMatchObject({ isError: true, text: "This Wanderpage serves only its owner. Sign in with the owner account." });
  });

  it("BUI-2100 R2: start_generation reports the page built from the saved curation and queues no generation run (BUI-2206)", async () => {
    const context = await fixture(),
      story = await ownerStory(context);
    await confirmUploads(context, story.id);
    expect((await call(context.client, "save_curation", curation(story.id))).isError).toBe(false);
    const result = await call(context.client, "start_generation", { storyId: story.id });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, status: "draft", photoCount: 2 });

    // A second call reports the same page: the only run is the curation build, and the paid generation runner never starts.
    const again = await call(context.client, "start_generation", { storyId: story.id });
    expect(again).toMatchObject({ isError: false, data: { id: story.id, status: "draft" } });
    expect((await context.repository.listRuns(story.id)).map(run => run.processorRevision)).toEqual([curationRevision]);
    expect(context.started).toEqual([]);
  });

  it("BUI-2100 R2: with generation switched off the page cannot be built, so start_generation has no curation and queues nothing", async () => {
    const context = await fixture(),
      story = await ownerStory(context);
    await confirmUploads(context, story.id);
    context.policy.enabled = false;
    const saved = await call(context.client, "save_curation", curation(story.id));
    expect(saved).toMatchObject({ isError: true, text: "Story creation is temporarily unavailable." });
    const result = await call(context.client, "start_generation", { storyId: story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/has no saved curation\. Call get_photos .* save_curation/);
    expect(await context.repository.listRuns(story.id)).toEqual([]);
    expect(context.started).toEqual([]);
  });

  it("BUI-2100 R2: start_generation refuses a story with too few uploads and no saved curation, and queues nothing (BUI-2206)", async () => {
    const context = await fixture(),
      story = await ownerStory(context);
    await confirmUploads(context, story.id, minStoryPhotos - 1);
    const result = await call(context.client, "start_generation", { storyId: story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/has no saved curation\. Call get_photos .* save_curation/);
    expect(await context.repository.listRuns(story.id)).toEqual([]);
    expect(context.started).toEqual([]);
  });

  it("BUI-2100 R3: set_title changes the title at the current version and keeps the privacy choices", async () => {
    const context = await fixture(),
      story = await ownerStory(context),
      result = await call(context.client, "set_title", { storyId: story.id, title: "Kyoto, slowly", version: story.version });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, title: "Kyoto, slowly", version: story.version + 1 });
    expect(await context.repository.findStory(story.id)).toMatchObject({
      title: "Kyoto, slowly",
      peopleMode: storyInput.peopleMode,
      locationPrivacy: storyInput.locationPrivacy,
    });
  });

  it("BUI-2100 R3: set_title with a stale version reports the conflict and the current version", async () => {
    const context = await fixture(),
      story = await ownerStory(context),
      first = await call(context.client, "set_title", { storyId: story.id, title: "Second title", version: story.version }),
      stale = await call(context.client, "set_title", { storyId: story.id, title: "Lost edit", version: story.version });
    expect(first.isError).toBe(false);
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ conflict: true, storyId: story.id, currentVersion: story.version + 1 });
    expect(stale.text).toContain(`current version is ${story.version + 1}`);
    expect((await context.repository.findStory(story.id))?.title).toBe("Second title");
  });

  it("BUI-2100 R3: set_title reports the current version when the story changes between its read and its save", async () => {
    const context = await fixture(),
      story = await ownerStory(context),
      update = context.stories.updateStory.bind(context.stories);
    context.stories.updateStory = async (...args) => {
      await context.repository.saveStory({ ...story, title: "Raced edit" }, story.version);
      return update(...args);
    };
    const result = await call(context.client, "set_title", { storyId: story.id, title: "Lost edit", version: story.version });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ conflict: true, currentVersion: story.version + 1 });
    expect((await context.repository.findStory(story.id))?.title).toBe("Raced edit");
  });

  it("BUI-2100 R3: set_title refuses a published story", async () => {
    const context = await fixture(),
      story = await asDraft(context, await ownerStory(context));
    await call(context.client, "publish", { storyId: story.id });
    const current = await context.repository.findStory(story.id),
      result = await call(context.client, "set_title", { storyId: story.id, title: "New", version: current?.version });
    expect(result).toMatchObject({ isError: true, text: "This story cannot be edited while it is processing or published." });
  });

  it("BUI-2100 R1, R2: create_story and save_curation count limits by a stable keyed hash of the subject, never the subject", async () => {
    const context = await fixture(),
      first = await call(context.client, "create_story", { title: "One", peopleMode: "exclude", locationPrivacy: "hidden" }),
      second = await call(context.client, "create_story", { title: "Two", peopleMode: "exclude", locationPrivacy: "hidden" });
    await confirmUploads(context, first.data?.id as string);
    expect((await call(context.client, "save_curation", curation(first.data?.id as string))).isError).toBe(false);
    const keys = [
      (await context.repository.findStory(first.data?.id as string))?.admissionKey,
      (await context.repository.findStory(second.data?.id as string))?.admissionKey,
      (await context.repository.listRuns(first.data?.id as string))[0]?.admissionKey,
    ];
    expect(new Set(keys)).toEqual(new Set([context.sessions.admissionKeyFor(owner)]));
    expect(keys[0]).not.toContain(owner);
  });

  it("BUI-2100 R4: publish changes only that story and returns its public URL", async () => {
    const context = await fixture(),
      story = await asDraft(context, await ownerStory(context)),
      other = await asDraft(context, await ownerStory(context, "Porto at night")),
      result = await call(context.client, "publish", { storyId: story.id });
    expect(result.isError).toBe(false);
    const published = await context.repository.findStory(story.id);
    expect(published?.status).toBe("published");
    expect(result.data).toMatchObject({
      id: story.id,
      status: "published",
      published: true,
      publicUrl: `${origin}/s/${published?.publicSlug}`,
    });
    expect(await context.repository.findStory(other.id)).toEqual(other);
  });

  it("BUI-2100 R4: publish refuses a draft that is not final, with the reason", async () => {
    const context = await fixture(),
      story = await ownerStory(context),
      result = await call(context.client, "publish", { storyId: story.id });
    expect(result).toMatchObject({ isError: true, text: "Finish a private draft before publishing." });
    expect((await context.repository.findStory(story.id))?.status).toBe("uploading");
  });

  it("BUI-2100 R4: unpublish changes only that story and returns the unpublished state", async () => {
    const context = await fixture(),
      story = await asDraft(context, await ownerStory(context)),
      other = await asDraft(context, await ownerStory(context, "Porto at night"));
    await call(context.client, "publish", { storyId: story.id });
    await call(context.client, "publish", { storyId: other.id });
    const otherPublished = await context.repository.findStory(other.id),
      result = await call(context.client, "unpublish", { storyId: story.id });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, status: "draft", published: false, publicUrl: null });
    expect((await context.repository.findStory(story.id))?.status).toBe("draft");
    expect(await context.repository.findStory(other.id)).toEqual(otherPublished);
  });

  it("BUI-2100 R4: unpublish refuses a story that is not published", async () => {
    const context = await fixture(),
      story = await ownerStory(context),
      result = await call(context.client, "unpublish", { storyId: story.id });
    expect(result).toMatchObject({ isError: true, text: "Only a published story can be unpublished." });
  });

  it("BUI-2100 R5: delete_story starts the existing deletion, removes its objects and confirms it", async () => {
    const context = await fixture(),
      story = await ownerStory(context),
      kept = await ownerStory(context, "Porto at night"),
      result = await call(context.client, "delete_story", { storyId: story.id });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, status: "deleting", deleted: true });
    expect((await context.repository.findStory(story.id))?.status).toBe("deleting");
    expect(context.removed).toEqual([story.id]);
    const listed = await call(context.client, "list_stories", {});
    expect((listed.data?.stories as Array<{ id: string }>).map(entry => entry.id)).toEqual([kept.id]);
  });

  it("BUI-2100 R5: delete_story reports a story that does not exist", async () => {
    const context = await fixture(),
      result = await call(context.client, "delete_story", { storyId: "00000000-0000-4000-8000-000000000000" });
    expect(result).toMatchObject({ isError: true, text: "Story not found." });
    expect(context.removed).toEqual([]);
  });

  it("BUI-2100 R2-R5: every story tool refuses another owner's story and leaves it unchanged", async () => {
    const context = await fixture(),
      stranger = await strangerStory(context);
    await confirmUploads(context, stranger.id);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["start_generation", { storyId: stranger.id }],
      ["set_title", { storyId: stranger.id, title: "Taken over", version: stranger.version }],
      ["publish", { storyId: stranger.id }],
      ["unpublish", { storyId: stranger.id }],
      ["delete_story", { storyId: stranger.id }],
    ];
    for (const [name, args] of calls) {
      const result = await call(context.client, name, args);
      expect(result.isError, name).toBe(true);
      expect(result.text, name).not.toContain("Someone else");
      expect(result.text, name).toMatch(/^(This story belongs to another private session\.|Story not found\.)$/);
    }
    expect(await context.repository.findStory(stranger.id)).toEqual(stranger);
    expect(await context.repository.listRuns(stranger.id)).toEqual([]);
    expect(context.started).toEqual([]);
    expect(context.removed).toEqual([]);
  });
});
