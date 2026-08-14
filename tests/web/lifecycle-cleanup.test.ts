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
        admittedAt: now,
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

  it("persists a workflow id without overwriting concurrent run progress", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("workflow-id", "client", now),
      run: StoryRun = {
        id: crypto.randomUUID(),
        storyId: story.id,
        processorRevision: "web-v1",
        admittedAt: now,
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
    await repository.claimRun(story.id, run.id, new Date(now.getTime() + 1000));
    await repository.setWorkflowRunId(run.id, "workflow-1", new Date(now.getTime() + 2000));
    expect(await repository.findRun(run.id)).toMatchObject({
      workflowRunId: "workflow-1",
      status: "processing",
      stage: "curating",
      progress: 5,
      attempts: 1,
    });
  });

  it("rejects stale progress after deletion cancels a run", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("cancel-progress", "client", now),
      run: StoryRun = {
        id: crypto.randomUUID(),
        storyId: story.id,
        processorRevision: "web-v1",
        admittedAt: now,
        status: "processing",
        stage: "curating",
        progress: 5,
        attempts: 1,
        sourceUploadIds: [],
        updatedAt: now,
      };
    await repository.createSession(session);
    await repository.createStory({ ...story, status: "processing", activeRunId: run.id });
    await repository.createRun(run);
    await repository.beginDeleteStory(story.id, session.id, new Date(now.getTime() + 1000));
    await expect(repository.markRunProgress(story.id, run.id, "curating", 12, new Date(now.getTime() + 2000))).rejects.toThrow(
      "RUN_STATE_CONFLICT"
    );
    expect((await repository.findRun(run.id))?.status).toBe("cancelled");
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
        admittedAt: now,
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
        admittedAt: now,
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
    await expect(cleanupExpiredPrivateStories(repository, new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000))).resolves.toMatchObject({
      purged: 0,
    });
    await expect(cleanupExpiredPrivateStories(repository, new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000))).resolves.toMatchObject({
      purged: 1,
    });
    await expect(repository.findStory(story.id)).resolves.toBeUndefined();
    await expect(repository.findSessionBySecretHash(session.secretHash)).resolves.toBeUndefined();
  });

  it("clears expired admission identifiers while retaining stories", async () => {
    const repository = new MemoryStoryRepository(),
      created = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("admission", "client-address-hash", created),
      run: StoryRun = {
        id: crypto.randomUUID(),
        storyId: story.id,
        processorRevision: "web-v1",
        admissionKey: "client-address-hash",
        admittedAt: created,
        status: "complete",
        stage: "complete",
        progress: 100,
        attempts: 1,
        sourceUploadIds: [],
        updatedAt: created,
      };
    await repository.createSession({ ...session, expiresAt: new Date("2026-09-13T00:00:00Z") });
    await repository.createStory({ ...story, status: "published" });
    await repository.createRun(run);
    await expect(repository.clearExpiredAdmissionKeys(new Date("2026-08-14T00:00:01Z"))).resolves.toBe(2);
    expect((await repository.findStory(story.id))?.admissionKey).toBeUndefined();
    expect((await repository.findRun(run.id))?.admissionKey).toBeUndefined();
  });

  it("expires admission identifiers before unrelated cleanup can fail", async () => {
    const repository = new MemoryStoryRepository(),
      admittedAt = new Date("2026-08-13T00:00:00Z"),
      now = new Date("2026-08-14T00:00:01Z"),
      { session, story } = records("independent-admission-expiry", "client-address-hash", admittedAt),
      run: StoryRun = {
        id: crypto.randomUUID(),
        storyId: story.id,
        processorRevision: "web-v1",
        admissionKey: "client-address-hash",
        admittedAt,
        status: "processing",
        stage: "curating",
        progress: 50,
        attempts: 1,
        sourceUploadIds: [],
        updatedAt: now,
      };
    await repository.createSession(session);
    await repository.createStory(story);
    await repository.createRun(run);
    vi.spyOn(repository, "listStoriesReadyForDeletion").mockResolvedValueOnce([story]);
    vi.spyOn(repository, "listUploads").mockRejectedValueOnce(new Error("storage cleanup unavailable"));

    await expect(cleanupExpiredPrivateStories(repository, now)).rejects.toThrow("storage cleanup unavailable");
    expect((await repository.findStory(story.id))?.admissionKey).toBeUndefined();
    expect((await repository.findRun(run.id))?.admissionKey).toBeUndefined();
  });

  it("retains an old draft while its owner session is active", async () => {
    const repository = new MemoryStoryRepository(),
      created = new Date("2026-06-01T00:00:00Z"),
      now = new Date("2026-08-13T00:00:00Z"),
      recordsValue = records("active-owner", "client", created),
      session = { ...recordsValue.session, lastSeenAt: now, expiresAt: new Date("2026-09-12T00:00:00Z") };
    await repository.createSession(session);
    await repository.createStory({ ...recordsValue.story, ownerSessionId: session.id, status: "draft" });
    await expect(cleanupExpiredPrivateStories(repository, now)).resolves.toMatchObject({ expired: 0, deleted: 0 });
    expect((await repository.findStory(recordsValue.story.id))?.status).toBe("draft");
  });

  it("lets an authenticated operator immediately revoke a published story", async () => {
    const repository = new MemoryStoryRepository(),
      now = new Date("2026-08-13T00:00:00Z"),
      { session, story } = records("operator", "client", now);
    await repository.createSession(session);
    await repository.createStory({ ...story, status: "published", publicSlug: "public-story" });
    await repository.beginOperatorDeleteStory(story.id, now);
    expect(await repository.findPublishedStoryBySlug("public-story")).toBeUndefined();
    expect((await repository.findStory(story.id))?.status).toBe("deleting");
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
