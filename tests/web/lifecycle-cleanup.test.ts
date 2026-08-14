import { describe, expect, it, vi } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { cleanupStoryObjects } from "@/lib/web/object-cleanup";
import { cleanupExpiredPrivateStories } from "@/lib/web/story-retention";
import type { OwnerSession, Story, StoryRun } from "@/lib/web/types";

describe("hosted lifecycle cleanup", () => {
  it("does not persist a provisional session when client admission fails", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      limits = { sessionStories: 3, clientStories: 1, since: new Date("2026-08-12T00:00:00Z") },
      first = records("first", "shared-client", now),
      rejected = records("rejected", "shared-client", now);
    await repository.createSessionAndStoryAdmitted(first.session, first.story, limits);
    await expect(repository.createSessionAndStoryAdmitted(rejected.session, rejected.story, limits)).rejects.toThrow("CLIENT_STORY_LIMIT");
    await expect(repository.findSessionBySecretHash(rejected.session.secretHash)).resolves.toBeUndefined();
  });

  it("atomically claims a run and resumes the same claim idempotently", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("claim", "client", now),
      run: StoryRun = {
        id: crypto.randomUUID(),
        storyId: story.id,
        processorRevision: "web-v1",
        status: "queued",
        stage: "queued",
        progress: 0,
        attempts: 0,
        sourceUploadIds: [],
        updatedAt: now,
      };
    await repository.createSession(session);
    await repository.createStory({ ...story, status: "queued", activeRunId: run.id });
    await repository.createRun(run);
    const first = await repository.claimRun(story.id, run.id, now),
      resumed = await repository.claimRun(story.id, run.id, new Date(now.getTime() + 1000));
    expect(first.story.status).toBe("processing");
    expect(first.run.attempts).toBe(1);
    expect(resumed.run.attempts).toBe(1);
  });

  it("binds a run to its admitted source set and excludes later uploads", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("sources", "client", now),
      firstUpload = uploadFor(story.id, "first", now),
      laterUpload = uploadFor(story.id, "later", now),
      run: StoryRun = {
        id: crypto.randomUUID(),
        storyId: story.id,
        processorRevision: "web-v1",
        status: "queued",
        stage: "queued",
        progress: 0,
        attempts: 0,
        sourceUploadIds: [],
        updatedAt: now,
      };
    await repository.createSession(session);
    await repository.createStory(story);
    await repository.createUpload(firstUpload);
    await repository.queueRun(story, run, {
      sessionStarts: 3,
      clientStarts: 6,
      globalStarts: 25,
      since: new Date(now.getTime() - 1),
      now,
      minPhotos: 1,
    });
    await repository.createUpload(laterUpload);

    const persisted = await repository.findRun(run.id);
    expect(persisted?.sourceUploadIds).toEqual([firstUpload.id]);
    expect((await repository.listUploadsByIds(persisted!.sourceUploadIds)).map(upload => upload.id)).toEqual([firstUpload.id]);
  });

  it("tombstones a story and deletes every source and run-specific derivative prefix", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("delete", "client", now),
      run: StoryRun = {
        id: crypto.randomUUID(),
        storyId: story.id,
        processorRevision: "web-v1",
        status: "complete",
        stage: "complete",
        progress: 100,
        attempts: 1,
        sourceUploadIds: [],
        updatedAt: now,
      },
      remove = vi.fn(async () => undefined),
      storage = {
        delete: remove,
        list: vi.fn(async (prefix: string) => ({ paths: [`${prefix}photo.webp`] })),
      };
    await repository.createSession(session);
    await repository.createStory(story);
    await repository.createRun(run);
    await repository.createUpload({
      id: crypto.randomUUID(),
      storyId: story.id,
      blobPath: `sources/${story.id}/photo`,
      originalName: "photo.jpg",
      declaredType: "image/jpeg",
      status: "confirmed",
      createdAt: now,
    });
    await repository.beginDeleteStory(story.id, session.id, new Date(now.getTime() - 16 * 60 * 1000));
    await cleanupStoryObjects(repository, story.id, now, storage);
    await repository.finishDeleteStory(story.id, now);
    expect((await repository.findStory(story.id))?.status).toBe("deleted");
    expect(storage.list).toHaveBeenCalledWith(`derivatives/${story.id}/web-v1/${run.id}/`, undefined);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("keeps deletion retryable until upload tokens expire", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("delayed-delete", "client", now);
    await repository.createSession(session);
    await repository.createStory(story);
    await repository.beginDeleteStory(story.id, session.id, now);
    await expect(repository.finishDeleteStory(story.id, now)).rejects.toThrow("STORY_NOT_DELETING");
    expect((await repository.findStory(story.id))?.status).toBe("deleting");
    await repository.finishDeleteStory(story.id, new Date(now.getTime() + 15 * 60 * 1000));
    expect((await repository.findStory(story.id))?.status).toBe("deleted");
  });

  it("expires abandoned private drafts and purges their owner records", async () => {
    const repository = new MemoryStoryRepository(),
      created = new Date("2026-06-01T00:00:00Z"),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("retention", "client-address", created);
    await repository.createSession(session);
    await repository.createStory({ ...story, status: "draft" });

    await expect(cleanupExpiredPrivateStories(repository, now)).resolves.toMatchObject({ expired: 1, deleted: 1 });
    await expect(cleanupExpiredPrivateStories(repository, new Date(now.getTime() + 25 * 60 * 60 * 1000))).resolves.toMatchObject({
      purged: 1,
    });
    await expect(repository.findStory(story.id)).resolves.toBeUndefined();
    await expect(repository.findSessionBySecretHash(session.secretHash)).resolves.toBeUndefined();
  });
});

function records(label: string, admissionKey: string, now: Date): { session: OwnerSession; story: Story } {
  const session: OwnerSession = {
    id: crypto.randomUUID(),
    secretHash: `hash-${label}`,
    csrfToken: `csrf-${label}`,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    termsVersion: "v1",
    uploadConsentVersion: "v1",
  };
  return {
    session,
    story: {
      id: crypto.randomUUID(),
      ownerSessionId: session.id,
      admissionKey,
      status: "uploading",
      title: label,
      peopleMode: "exclude",
      locationPrivacy: "hidden",
      processorRevision: "web-v1",
      sourceExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
      version: 0,
    },
  };
}

function uploadFor(storyId: string, label: string, now: Date) {
  return {
    id: crypto.randomUUID(),
    storyId,
    blobPath: `sources/${storyId}/${label}`,
    originalName: `${label}.jpg`,
    declaredType: "image/jpeg" as const,
    status: "confirmed" as const,
    confirmedAt: now,
    createdAt: now,
  };
}
