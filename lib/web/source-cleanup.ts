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
  for (const upload of uploads) {
    try {
      await deleteObject(upload.blobPath);
      await repository.saveUpload(markDeleted(upload, now));
    } catch (error) {
      await repository.saveUpload({ ...upload, status: upload.confirmedAt ? "confirmed" : "reserved" });
      throw error;
    }
    deleted += 1;
  }
  return { deleted, remaining: uploads.length === limit };
}

function markDeleted(upload: StoryUpload, now: Date): StoryUpload {
  return { ...upload, status: "deleted", deletedAt: now };
}
