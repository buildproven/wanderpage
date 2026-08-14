import { describe, expect, it, vi } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { cleanupExpiredSources } from "@/lib/web/source-cleanup";
import { hashSecret, StoryService } from "@/lib/web/story-service";

const input = {
  title: "Expired sources",
  peopleMode: "exclude" as const,
  locationPrivacy: "hidden" as const,
  termsVersion: "2026-08-13",
  uploadConsentVersion: "2026-08-13",
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
        () => ({ enabled: false, dailyLimit: 1 })
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

    await expect(cleanupExpiredSources(repository, now, 100, remove)).resolves.toEqual({ deleted: 2, remaining: false });
    expect(remove).toHaveBeenCalledTimes(2);
    expect((await repository.listUploads(story.id)).map(upload => upload.status)).toEqual(["deleted", "deleted"]);
  });
});
