import { describe, expect, it } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { hashSecret, StoryService, StoryServiceError } from "@/lib/web/story-service";
import type { StoryRunner } from "@/lib/web/types";
import { detectImageType, maxStoryPhotos, UploadService } from "@/lib/web/upload-service";

const input = {
  title: "Olympic Coast",
  peopleMode: "include" as const,
  locationPrivacy: "broad" as const,
  termsVersion: "2026-08-14-openai-retention-v1",
  uploadConsentVersion: "2026-08-14-openai-retention-v1",
};

describe("web upload service", () => {
  it("reserves an owner-scoped private upload with an application-owned path", async () => {
    const { stories, uploads } = fixture(),
      owner = await stories.createSession(input),
      story = await stories.createStory(owner.rawSecret, input),
      upload = await uploads.reserve(owner.rawSecret, {
        storyId: story.id,
        originalName: "seaside.jpg",
        contentType: "image/jpeg",
        byteSize: 1024,
      });

    expect(upload.blobPath).toMatch(new RegExp(`^sources/${story.id}/[0-9a-f-]+$`));
    expect(upload.status).toBe("reserved");
    expect(uploads.payload(upload)).toContain(upload.id);
  });

  it("rejects another anonymous session and oversized callback objects", async () => {
    const { stories, uploads } = fixture(),
      owner = await stories.createSession(input),
      intruder = await stories.createSession(input),
      story = await stories.createStory(owner.rawSecret, input),
      upload = await uploads.reserve(owner.rawSecret, {
        storyId: story.id,
        originalName: "seaside.jpg",
        contentType: "image/jpeg",
        byteSize: 1024,
      });

    await expect(
      uploads.reserve(intruder.rawSecret, { storyId: story.id, originalName: "stolen.jpg", contentType: "image/jpeg", byteSize: 1024 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<StoryServiceError>);
    await expect(
      uploads.confirm(JSON.parse(uploads.payload(upload)), { pathname: "sources/other-object", contentType: "image/jpeg" })
    ).rejects.toThrow("authorized upload contract");
  });

  it("enforces the story photo ceiling before issuing another upload authorization", async () => {
    const { stories, uploads } = fixture(),
      owner = await stories.createSession(input),
      story = await stories.createStory(owner.rawSecret, input);
    for (let index = 0; index < maxStoryPhotos; index++)
      await uploads.reserve(owner.rawSecret, {
        storyId: story.id,
        originalName: `photo-${index}.jpg`,
        contentType: "image/jpeg",
        byteSize: 1024,
      });
    await expect(
      uploads.reserve(owner.rawSecret, { storyId: story.id, originalName: "one-too-many.jpg", contentType: "image/jpeg", byteSize: 1024 })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" } satisfies Partial<StoryServiceError>);
  });

  it("allows active uploads in only one story per owner session", async () => {
    const { stories, uploads } = fixture(),
      owner = await stories.createSession(input),
      first = await stories.createStory(owner.rawSecret, { ...input, title: "First" }),
      second = await stories.createStory(owner.rawSecret, { ...input, title: "Second" });
    await uploads.reserve(owner.rawSecret, {
      storyId: first.id,
      originalName: "first.jpg",
      contentType: "image/jpeg",
      byteSize: 1024,
    });
    await expect(
      uploads.reserve(owner.rawSecret, {
        storyId: second.id,
        originalName: "second.jpg",
        contentType: "image/jpeg",
        byteSize: 1024,
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("verifies image bytes and rejects confirmation after generation starts", async () => {
    const { stories, uploads, repository } = fixture(),
      owner = await stories.createSession(input),
      story = await stories.createStory(owner.rawSecret, input),
      upload = await uploads.reserve(owner.rawSecret, {
        storyId: story.id,
        originalName: "seaside.jpg",
        contentType: "image/jpeg",
        byteSize: 1024,
      });
    const current = await repository.findStory(story.id);
    if (!current) throw new Error("Fixture story disappeared");
    await repository.saveStory({ ...current, status: "queued" }, current.version);
    await expect(
      uploads.confirm(JSON.parse(uploads.payload(upload)), { pathname: upload.blobPath, contentType: "image/jpeg" })
    ).rejects.toThrow("no longer accepts");
  });

  it("detects supported image signatures instead of trusting content-type metadata", () => {
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(() => detectImageType(new TextEncoder().encode("not an image"))).toThrow("supported image");
  });
});

function fixture() {
  const repository = new MemoryStoryRepository(),
    runner: StoryRunner = { start: async () => ({ workflowRunId: "workflow" }) },
    stories = new StoryService(
      repository,
      runner,
      undefined,
      secret => hashSecret(secret, "test-pepper"),
      () => ({ enabled: true, dailyLimit: 25 })
    );
  return { stories, repository, uploads: new UploadService(repository, stories, undefined, async () => "image/jpeg") };
}
