import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import type { TripManifest } from "@/lib/schemas/trip";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
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
    server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner }),
    client = new Client({ name: "hosted-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { repository, stories, sessions, client };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

function manifest(photoCount: number): TripManifest {
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
    photos: Array.from({ length: photoCount }, (_, index) => ({
      id: `photo-${index + 1}`,
      srcLarge: `/api/media/story/web-v1--run--large-${index}.webp`,
      srcMedium: `/api/media/story/web-v1--run--medium-${index}.webp`,
      srcThumb: `/api/media/story/web-v1--run--thumb-${index}.webp`,
      width: 100,
      height: 100,
      alt: "Selected photograph",
      containsPeople: false,
      source: "user" as const,
    })),
    sources: [],
  };
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("hosted MCP story tools (BUI-2099)", () => {
  it("BUI-2099 R4: list_stories returns only the owner's stories with status, title, photo count and publish state", async () => {
    const { repository, stories, sessions, client } = await fixture(),
      ownerSecret = await sessions.secretFor(owner),
      draft = await stories.createStory(ownerSecret, storyInput),
      published = await stories.createStory(ownerSecret, { ...storyInput, title: "Porto at night" }),
      stranger = await stories.createSessionWithStory({ ...storyInput, title: "Someone else's trip" }, "client");
    await repository.saveStory({ ...draft, status: "draft", manifest: manifest(3) }, draft.version);
    await repository.saveStory(
      {
        ...published,
        status: "published",
        manifest: manifest(2),
        publicSlug: "porto-at-night-abc123",
        publishedAt: new Date("2026-11-02T00:00:00Z"),
        updatedAt: new Date(Date.now() + 1000),
      },
      published.version
    );

    const result = await call(client, "list_stories", {});
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({
      stories: [
        expect.objectContaining({
          id: published.id,
          title: "Porto at night",
          status: "published",
          photoCount: 2,
          published: true,
          publicPath: "/s/porto-at-night-abc123",
          publishedAt: "2026-11-02T00:00:00.000Z",
        }),
        expect.objectContaining({
          id: draft.id,
          title: "Kyoto in autumn",
          status: "draft",
          photoCount: 3,
          published: false,
          publicPath: null,
        }),
      ],
    });
    expect(result.text).not.toContain(stranger.story.id);
    expect(result.text).not.toContain("Someone else");
    expect(result.text).not.toContain("ownerSessionId");
    expect(result.text).not.toContain("admissionKey");
  });

  it("BUI-2099 R4: get_story returns one owner story's status, title, photo count and publish state", async () => {
    const { stories, sessions, client } = await fixture(),
      story = await stories.createStory(await sessions.secretFor(owner), storyInput),
      result = await call(client, "get_story", { storyId: story.id });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, title: "Kyoto in autumn", status: "uploading", photoCount: 0, published: false });
  });

  it("BUI-2099 R4: get_story refuses a story of another owner session and reveals nothing of it", async () => {
    const { stories, client } = await fixture(),
      stranger = await stories.createSessionWithStory({ ...storyInput, title: "Someone else's trip" }, "client"),
      result = await call(client, "get_story", { storyId: stranger.story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("This story belongs to another private session.");
  });

  it("BUI-2099 R4: get_story reports a story that does not exist, and rejects an id that is not a UUID", async () => {
    const { client } = await fixture(),
      missing = await call(client, "get_story", { storyId: "00000000-0000-4000-8000-000000000000" }),
      malformed = await call(client, "get_story", { storyId: "not-a-uuid" });
    expect(missing).toMatchObject({ isError: true, text: "Story not found." });
    expect(malformed.isError).toBe(true);
  });

  it("BUI-2099 R4: list_stories leaves out a story that is being deleted", async () => {
    const { repository, stories, sessions, client } = await fixture(),
      ownerSecret = await sessions.secretFor(owner),
      kept = await stories.createStory(ownerSecret, storyInput),
      doomed = await stories.createStory(ownerSecret, { ...storyInput, title: "Doomed trip" });
    await repository.saveStory({ ...doomed, status: "deleting" }, doomed.version);
    const result = await call(client, "list_stories", {});
    expect((result.data?.stories as Array<{ id: string }>).map(story => story.id)).toEqual([kept.id]);
  });
});
