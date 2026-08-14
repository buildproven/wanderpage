import type { StoryRepository } from "@/lib/web/types";
import { cleanupStoryObjects } from "@/lib/web/object-cleanup";

const privateRetentionMs = 30 * 24 * 60 * 60 * 1000;
const tombstoneRetentionMs = 30 * 24 * 60 * 60 * 1000;
const admissionRetentionMs = 24 * 60 * 60 * 1000;

export async function cleanupExpiredPrivateStories(repository: StoryRepository, now = new Date(), limit = 50) {
  const expired = await repository.claimExpiredPrivateStories(now, new Date(now.getTime() - privateRetentionMs), limit);
  const ready = await repository.listStoriesReadyForDeletion(now, limit);
  for (const story of ready) {
    await cleanupStoryObjects(repository, story.id, now);
    await repository.finishDeleteStory(story.id, now);
  }
  const purged = await repository.purgeDeletedStories(new Date(now.getTime() - tombstoneRetentionMs), limit);
  const clearedAdmissionKeys = await repository.clearExpiredAdmissionKeys(new Date(now.getTime() - admissionRetentionMs));
  return {
    expired: expired.length,
    deleted: ready.length,
    purged,
    clearedAdmissionKeys,
    remaining: expired.length === limit || ready.length === limit || purged === limit,
  };
}
