import { describe, expect, it } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { hashSecret, StoryService, StoryServiceError } from "@/lib/web/story-service";
import type { StoryRunner } from "@/lib/web/types";
import { minStoryPhotos } from "@/lib/web/limits";

const input = {
  title: "Oregon Coast",
  peopleMode: "exclude" as const,
  locationPrivacy: "approximate" as const,
  termsVersion: "2026-08-13",
  uploadConsentVersion: "2026-08-13",
};

describe("web story service", () => {
  it("creates a private owner session and an uploading story", async () => {
    const service = fixture().service,
      session = await service.createSession(input),
      story = await service.createStory(session.rawSecret, input);

    expect(session.rawSecret).toHaveLength(43);
    expect(story).toMatchObject({
      title: "Oregon Coast",
      status: "uploading",
      peopleMode: "exclude",
      locationPrivacy: "approximate",
      version: 0,
    });
    expect(story.sourceExpiresAt.getTime() - story.createdAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("does not expose a private story across anonymous owner sessions", async () => {
    const service = fixture().service,
      owner = await service.createSession(input),
      intruder = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input);

    await expect(service.getOwnedStory(intruder.rawSecret, story.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<StoryServiceError>);
    await expect(service.listOwnedStories(intruder.rawSecret)).resolves.toEqual([]);
  });

  it("requires a completed photo, then queues one durable run and rejects duplicates", async () => {
    const { service, starts, repository } = fixture(),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input);

    await expect(service.queueGeneration(owner.rawSecret, story.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    } satisfies Partial<StoryServiceError>);
    for (let index = 0; index < minStoryPhotos; index++)
      await repository.createUpload({
        id: `f70c4a98-ec74-42b0-a1a9-d90e22c19c8${index}`,
        storyId: story.id,
        blobPath: `sources/${story.id}/photo-${index}`,
        originalName: `photo-${index}.jpg`,
        declaredType: "image/jpeg",
        byteSize: 1024,
        status: "confirmed",
        createdAt: new Date(),
        confirmedAt: new Date(),
      });
    const queued = await service.queueGeneration(owner.rawSecret, story.id);

    expect(queued.status).toBe("queued");
    expect(queued.activeRunId).toBeDefined();
    expect(starts).toEqual([{ storyId: story.id, runId: queued.activeRunId }]);
    await expect(service.queueGeneration(owner.rawSecret, story.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    } satisfies Partial<StoryServiceError>);
  });

  it("requires a finalized private draft before explicit publication", async () => {
    const { service, repository } = fixture(),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input);

    await expect(service.publish(owner.rawSecret, story.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    } satisfies Partial<StoryServiceError>);
    const current = await repository.findStory(story.id);
    if (!current) throw new Error("Fixture story disappeared");
    const draft = await repository.saveStory(
      { ...current, status: "draft", manifest: demoManifest(), updatedAt: new Date() },
      current.version
    );
    const published = await service.publish(owner.rawSecret, draft.id);
    expect(published.status).toBe("published");
    expect(published.publicSlug).toMatch(/^oregon-coast-[a-f0-9]{10}$/);
    expect((await service.unpublish(owner.rawSecret, draft.id)).status).toBe("draft");
  });
});

function fixture() {
  const repository = new MemoryStoryRepository(),
    starts: Array<{ storyId: string; runId: string | undefined }> = [],
    runner: StoryRunner = {
      start: async (storyId, runId) => {
        starts.push({ storyId, runId });
        return { workflowRunId: `workflow-${runId}` };
      },
    };
  return { repository, starts, service: new StoryService(repository, runner, undefined, secret => hashSecret(secret, "test-pepper")) };
}

function demoManifest() {
  return {
    schemaVersion: "1.0" as const,
    generatedAt: "2026-08-13T00:00:00.000Z",
    published: false,
    title: "Oregon Coast",
    subtitle: "A private draft",
    opening: "A private opening.",
    closing: "A private closing.",
    peopleMode: "exclude" as const,
    theme: { background: "#fff", foreground: "#111", accent: "#333", muted: "#666" },
    heroPhotoId: "photo-1",
    stats: [],
    destinations: [],
    route: [],
    chapters: [],
    photos: [],
    sources: [],
  };
}
