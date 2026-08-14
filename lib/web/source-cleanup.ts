import { del } from "@vercel/blob";
import type { StoryRepository, StoryUpload } from "@/lib/web/types";

export async function cleanupExpiredSources(
  repository: StoryRepository,
  now = new Date(),
  limit = 100,
  deleteObject: (pathname: string) => Promise<unknown> = pathname => del(pathname)
) {
  const uploads = await repository.listExpiredSourceUploads(now, limit);
  let deleted = 0;
  for (const upload of uploads) {
    await deleteObject(upload.blobPath);
    await repository.saveUpload(markDeleted(upload, now));
    deleted += 1;
  }
  return { deleted, remaining: uploads.length === limit };
}

function markDeleted(upload: StoryUpload, now: Date): StoryUpload {
  return { ...upload, status: "deleted", deletedAt: now };
}
