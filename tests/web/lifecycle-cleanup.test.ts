import { describe, expect, it, vi } from "vitest";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { cleanupStoryObjects } from "@/lib/web/object-cleanup";
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
    await repository.beginDeleteStory(story.id, session.id, now);
    await cleanupStoryObjects(repository, story.id, now, storage);
    await repository.finishDeleteStory(story.id, now);
    expect((await repository.findStory(story.id))?.status).toBe("deleted");
    expect(storage.list).toHaveBeenCalledWith(`derivatives/${story.id}/web-v1/${run.id}/`, undefined);
    expect(remove).toHaveBeenCalledTimes(2);
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
