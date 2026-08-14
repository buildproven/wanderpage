import { del, list } from "@vercel/blob";
import type { StoryRepository, StoryRun } from "@/lib/web/types";

type ObjectStorage = {
  delete(paths: string[]): Promise<unknown>;
  list(prefix: string, cursor?: string): Promise<{ paths: string[]; cursor?: string }>;
};

const blobStorage: ObjectStorage = {
  delete: paths => del(paths),
  list: async (prefix, cursor) => {
    const page = await list({ prefix, cursor, limit: 1000 });
    return { paths: page.blobs.map(blob => blob.url), cursor: page.hasMore ? page.cursor : undefined };
  },
};

export async function cleanupRunDerivatives(repository: StoryRepository, run: StoryRun, now = new Date(), storage = blobStorage) {
  await deletePrefix(`derivatives/${run.storyId}/${run.processorRevision}/${run.id}/`, storage);
  await repository.markRunDerivativesDeleted(run.id, now);
}

export async function cleanupFailedDerivatives(repository: StoryRepository, now = new Date(), limit = 50) {
  const runs = await repository.listRunsForDerivativeCleanup(limit);
  for (const run of runs) await cleanupRunDerivatives(repository, run, now);
  return { deletedRuns: runs.length, remaining: runs.length === limit };
}

export async function cleanupStoryObjects(repository: StoryRepository, storyId: string, now = new Date(), storage = blobStorage) {
  const uploads = await repository.listUploads(storyId),
    runs = await repository.listRuns(storyId);
  if (uploads.length) await storage.delete(uploads.map(upload => upload.blobPath));
  for (const run of runs) await cleanupRunDerivatives(repository, run, now, storage);
}

async function deletePrefix(prefix: string, storage: ObjectStorage) {
  let cursor: string | undefined;
  do {
    const page = await storage.list(prefix, cursor);
    if (page.paths.length) await storage.delete(page.paths);
    cursor = page.cursor;
  } while (cursor);
}
