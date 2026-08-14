import { del } from "@vercel/blob";
import type { StoryRepository, StoryUpload } from "@/lib/web/types";

export async function cleanupExpiredSources(
  repository: StoryRepository,
  now = new Date(),
  limit = 100,
  deleteObject: (pathname: string) => Promise<unknown> = pathname => del(pathname)
) {
  await repository.expireStaleRuns(now, new Date(now.getTime() - 6 * 60 * 60 * 1000), limit);
  const uploads = await repository.claimExpiredSourceUploads(now, limit);
  let deleted = 0;
  const failures: Array<{ uploadId: string; error: string }> = [];
  for (const upload of uploads) {
    try {
      await deleteObject(upload.blobPath);
      await repository.saveUpload(markDeleted(upload, now));
    } catch (error) {
      await repository.saveUpload({ ...upload, status: upload.confirmedAt ? "confirmed" : "reserved", cleanupClaimedAt: undefined });
      failures.push({ uploadId: upload.id, error: error instanceof Error ? error.message : "Object deletion failed." });
      continue;
    }
    deleted += 1;
  }
  return { deleted, failures, remaining: uploads.length === limit };
}

function markDeleted(upload: StoryUpload, now: Date): StoryUpload {
  return { ...upload, status: "deleted", cleanupClaimedAt: undefined, deletedAt: now };
}
