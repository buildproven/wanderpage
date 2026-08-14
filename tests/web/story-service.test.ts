import { describe, expect, it } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { hashSecret, StoryService, StoryServiceError } from "@/lib/web/story-service";
import type { StoryRunner } from "@/lib/web/types";
import { minStoryPhotos } from "@/lib/web/limits";

const input = {
  title: "Oregon Coast",
  peopleMode: "exclude" as const,
  locationPrivacy: "approximate" as const,
  termsVersion: "2026-08-14-hobby-retention-v2",
  uploadConsentVersion: "2026-08-14-hobby-retention-v2",
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

  it("rejects creation without the current provider and retention disclosure", async () => {
    const repository = new MemoryStoryRepository(),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        undefined,
        secret => hashSecret(secret, "test-pepper"),
        () => ({ enabled: true, dailyLimit: 25 })
      );
    await expect(service.createSessionWithStory({ ...input, uploadConsentVersion: "stale" }, "client")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
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

    await expect(service.queueGeneration(owner.rawSecret, story.id, "client-a")).rejects.toMatchObject({
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
    const queued = await service.queueGeneration(owner.rawSecret, story.id, "client-a");

    expect(queued.status).toBe("queued");
    expect(queued.activeRunId).toBeDefined();
    expect(starts).toEqual([{ storyId: story.id, runId: queued.activeRunId }]);
    await expect(service.queueGeneration(owner.rawSecret, story.id, "client-a")).rejects.toMatchObject({
      code: "INVALID_STATE",
    } satisfies Partial<StoryServiceError>);
  });

  it("does not extend source-photo retention when generation starts", async () => {
    let now = new Date("2026-08-14T00:00:00Z");
    const repository = new MemoryStoryRepository(),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => now,
        secret => hashSecret(secret, "test-pepper"),
        () => ({ enabled: true, dailyLimit: 25 })
      ),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input);
    await addConfirmedUploads(repository, story.id);
    now = new Date("2026-08-14T23:00:00Z");
    const queued = await service.queueGeneration(owner.rawSecret, story.id, "client-a");
    expect(queued.sourceExpiresAt).toEqual(story.sourceExpiresAt);
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

  it("rejects privacy-policy changes after source deletion without destroying the draft", async () => {
    const { service, repository } = fixture(),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input),
      current = await repository.findStory(story.id);
    if (!current) throw new Error("Fixture story disappeared");
    const draft = await repository.saveStory({ ...current, status: "draft", manifest: demoManifest() }, current.version);
    await expect(
      service.updateStory(owner.rawSecret, draft.id, draft.version, {
        title: draft.title,
        peopleMode: draft.peopleMode,
        locationPrivacy: "hidden",
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await repository.findStory(draft.id)).toMatchObject({ status: "draft", manifest: demoManifest() });
  });

  it("rejects public-manifest edits that violate privacy policy", async () => {
    const { service, repository } = fixture(),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input),
      draft = await repository.saveStory({ ...story, status: "draft", manifest: demoManifest() }, story.version);

    await expect(
      service.updateStory(owner.rawSecret, draft.id, draft.version, {
        title: "api_key=credential-shaped-test-value",
        peopleMode: draft.peopleMode,
        locationPrivacy: draft.locationPrivacy,
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await repository.findStory(draft.id))?.title).toBe("Oregon Coast");
  });

  it("denies owner reads as soon as deletion begins", async () => {
    const { service } = fixture(),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input);
    await service.prepareDelete(owner.rawSecret, story.id);
    await expect(service.getOwnedStory(owner.rawSecret, story.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed before queueing when generation is disabled", async () => {
    const policy = { enabled: true, dailyLimit: 25 },
      { repository, service } = fixture(policy),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input);
    await addConfirmedUploads(repository, story.id);
    policy.enabled = false;
    await expect(service.queueGeneration(owner.rawSecret, story.id, "client-a")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await repository.findStory(story.id))?.status).toBe("uploading");
  });

  it("limits story creation per owner and renews active session expiry", async () => {
    let now = new Date("2026-08-13T00:00:00Z");
    const repository = new MemoryStoryRepository(),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => now,
        secret => hashSecret(secret, "test-pepper"),
        () => ({ enabled: true, dailyLimit: 25 })
      ),
      owner = await service.createSession(input);
    for (let index = 0; index < 3; index++) await service.createStory(owner.rawSecret, { ...input, title: `Story ${index}` }, "client-a");
    await expect(service.createStory(owner.rawSecret, input, "client-a")).rejects.toMatchObject({ code: "INVALID_STATE" });
    now = new Date("2026-09-10T00:00:00Z");
    const renewed = await service.requireSession(owner.rawSecret);
    expect(renewed.expiresAt.toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });
});

function fixture(policy = { enabled: true, dailyLimit: 25 }) {
  const repository = new MemoryStoryRepository(),
    starts: Array<{ storyId: string; runId: string | undefined }> = [],
    runner: StoryRunner = {
      start: async (storyId, runId) => {
        starts.push({ storyId, runId });
        return { workflowRunId: `workflow-${runId}` };
      },
    };
  return {
    repository,
    starts,
    service: new StoryService(
      repository,
      runner,
      undefined,
      secret => hashSecret(secret, "test-pepper"),
      () => policy,
      async () => undefined
    ),
  };
}

async function addConfirmedUploads(repository: MemoryStoryRepository, storyId: string) {
  for (let index = 0; index < minStoryPhotos; index++)
    await repository.createUpload({
      id: `f70c4a98-ec74-42b0-a1a9-d90e22c19d8${index}`,
      storyId,
      blobPath: `sources/${storyId}/extra-${index}`,
      originalName: `extra-${index}.jpg`,
      declaredType: "image/jpeg",
      byteSize: 1024,
      status: "confirmed",
      createdAt: new Date(),
      confirmedAt: new Date(),
    });
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
    photos: [
      {
        id: "photo-1",
        srcLarge: "/api/media/story/web-v1--test-run--large.webp",
        srcMedium: "/api/media/story/web-v1--test-run--medium.webp",
        srcThumb: "/api/media/story/web-v1--test-run--thumb.webp",
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
