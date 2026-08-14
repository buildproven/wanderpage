import { describe, expect, it } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { hashSecret, StoryService, StoryServiceError } from "@/lib/web/story-service";
import type { StoryRunner } from "@/lib/web/types";
import { maxStoryPhotos, UploadService } from "@/lib/web/upload-service";

const input = {
  title: "Olympic Coast",
  peopleMode: "include" as const,
  locationPrivacy: "broad" as const,
  termsVersion: "2026-08-13",
  uploadConsentVersion: "2026-08-13",
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
});

function fixture() {
  const repository = new MemoryStoryRepository(),
    runner: StoryRunner = { start: async () => ({ workflowRunId: "workflow" }) },
    stories = new StoryService(repository, runner, undefined, secret => hashSecret(secret, "test-pepper"));
  return { stories, uploads: new UploadService(repository, stories) };
}
