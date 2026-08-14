import { describe, expect, it, vi } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { cleanupExpiredSources } from "@/lib/web/source-cleanup";
import { hashSecret, StoryService } from "@/lib/web/story-service";

const input = {
  title: "Expired sources",
  peopleMode: "exclude" as const,
  locationPrivacy: "hidden" as const,
  termsVersion: "2026-08-14-openai-retention-v1",
  uploadConsentVersion: "2026-08-14-openai-retention-v1",
};

describe("source cleanup", () => {
  it("deletes confirmed and abandoned reserved objects after story expiry", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-15T00:00:00Z"),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => new Date("2026-08-13T00:00:00Z"),
        secret => hashSecret(secret, "pepper"),
        () => ({ enabled: true, dailyLimit: 1 })
      ),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input),
      remove = vi.fn(async () => undefined);
    for (const status of ["reserved", "confirmed"] as const)
      await repository.createUpload({
        id: crypto.randomUUID(),
        storyId: story.id,
        blobPath: `sources/${story.id}/${status}`,
        originalName: `${status}.jpg`,
        declaredType: "image/jpeg",
        byteSize: 10,
        status,
        createdAt: new Date("2026-08-13T00:00:00Z"),
      });

    await expect(cleanupExpiredSources(repository, now, 100, remove)).resolves.toEqual({ deleted: 2, failures: [], remaining: false });
    expect(remove).toHaveBeenCalledTimes(2);
    expect((await repository.listUploads(story.id)).map(upload => upload.status)).toEqual(["deleted", "deleted"]);
  });

  it("does not delete expired sources claimed by an active run", async () => {
    const repository = new MemoryStoryRepository(),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => new Date("2026-08-13T00:00:00Z"),
        secret => hashSecret(secret, "pepper"),
        () => ({ enabled: true, dailyLimit: 1 })
      ),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input),
      upload = {
        id: crypto.randomUUID(),
        storyId: story.id,
        blobPath: `sources/${story.id}/confirmed`,
        originalName: "confirmed.jpg",
        declaredType: "image/jpeg" as const,
        byteSize: 10,
        status: "confirmed" as const,
        createdAt: new Date("2026-08-13T00:00:00Z"),
      },
      remove = vi.fn(async () => undefined);
    await repository.createUpload(upload);
    await repository.saveStory({ ...story, status: "processing", activeRunId: crypto.randomUUID() }, story.version);
    await expect(cleanupExpiredSources(repository, new Date("2026-08-15T00:00:00Z"), 100, remove)).resolves.toEqual({
      deleted: 0,
      failures: [],
      remaining: false,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("expires a stale active run before deleting its retained sources", async () => {
    const repository = new MemoryStoryRepository(),
      createdAt = new Date("2026-08-13T00:00:00Z"),
      now = new Date("2026-08-15T00:00:00Z"),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => createdAt,
        secret => hashSecret(secret, "pepper"),
        () => ({ enabled: true, dailyLimit: 1 })
      ),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input),
      runId = crypto.randomUUID(),
      remove = vi.fn(async () => undefined);
    await repository.createRun({
      id: runId,
      storyId: story.id,
      processorRevision: "web-v1",
      status: "processing",
      stage: "curating",
      progress: 5,
      attempts: 1,
      sourceUploadIds: [],
      updatedAt: createdAt,
    });
    await repository.saveStory({ ...story, status: "processing", activeRunId: runId }, story.version);
    await repository.createUpload({
      id: crypto.randomUUID(),
      storyId: story.id,
      blobPath: `sources/${story.id}/stale`,
      originalName: "stale.jpg",
      declaredType: "image/jpeg",
      status: "confirmed",
      confirmedAt: createdAt,
      createdAt,
    });
    await expect(cleanupExpiredSources(repository, now, 100, remove)).resolves.toEqual({ deleted: 1, failures: [], remaining: false });
    expect((await repository.findRun(runId))?.status).toBe("failed");
    expect((await repository.findStory(story.id))?.status).toBe("failed");
  });

  it("reclaims a cleanup lease after a worker terminates", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-15T00:00:00Z"),
      { rawSecret } = await new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => new Date("2026-08-13T00:00:00Z"),
        secret => hashSecret(secret, "pepper"),
        () => ({ enabled: true, dailyLimit: 1 })
      ).createSession(input),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => new Date("2026-08-13T00:00:00Z"),
        secret => hashSecret(secret, "pepper"),
        () => ({ enabled: true, dailyLimit: 1 })
      ),
      story = await service.createStory(rawSecret, input),
      upload = {
        id: crypto.randomUUID(),
        storyId: story.id,
        blobPath: `sources/${story.id}/crash`,
        originalName: "crash.jpg",
        declaredType: "image/jpeg" as const,
        status: "confirmed" as const,
        confirmedAt: new Date("2026-08-13T00:00:00Z"),
        createdAt: new Date("2026-08-13T00:00:00Z"),
      };
    await repository.createUpload(upload);
    await repository.claimExpiredSourceUploads(now, 1);

    const remove = vi.fn(async () => undefined);
    await expect(cleanupExpiredSources(repository, new Date(now.getTime() + 16 * 60 * 1000), 100, remove)).resolves.toMatchObject({
      deleted: 1,
    });
    expect(remove).toHaveBeenCalledWith(upload.blobPath);
  });

  it("continues the batch and reports an object deletion failure", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-15T00:00:00Z"),
      service = new StoryService(
        repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        () => new Date("2026-08-13T00:00:00Z"),
        secret => hashSecret(secret, "pepper"),
        () => ({ enabled: true, dailyLimit: 1 })
      ),
      owner = await service.createSession(input),
      story = await service.createStory(owner.rawSecret, input),
      failed = crypto.randomUUID(),
      succeeded = crypto.randomUUID();
    for (const id of [failed, succeeded])
      await repository.createUpload({
        id,
        storyId: story.id,
        blobPath: `sources/${story.id}/${id}`,
        originalName: `${id}.jpg`,
        declaredType: "image/jpeg",
        status: "confirmed",
        confirmedAt: new Date("2026-08-13T00:00:00Z"),
        createdAt: new Date("2026-08-13T00:00:00Z"),
      });
    const remove = vi.fn(async (path: string) => {
      if (path.endsWith(failed)) throw new Error("storage unavailable");
    });
    const result = await cleanupExpiredSources(repository, now, 100, remove);
    expect(result).toEqual({ deleted: 1, failures: [{ uploadId: failed, error: "storage unavailable" }], remaining: false });
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
