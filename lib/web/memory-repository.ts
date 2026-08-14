import type {
  GenerationLimits,
  OwnerSession,
  Story,
  StoryCreationLimits,
  StoryRepository,
  StoryRun,
  StoryUpload,
  UploadLimits,
} from "@/lib/web/types";

export class MemoryStoryRepository implements StoryRepository {
  private readonly sessions = new Map<string, OwnerSession>();
  private readonly sessionsByHash = new Map<string, string>();
  private readonly stories = new Map<string, Story>();
  private readonly runs = new Map<string, StoryRun>();
  private readonly uploads = new Map<string, StoryUpload>();

  async createSession(session: OwnerSession) {
    this.sessions.set(session.id, clone(session));
    this.sessionsByHash.set(session.secretHash, session.id);
  }

  async createSessionAndStoryAdmitted(session: OwnerSession, story: Story, limits: StoryCreationLimits) {
    await this.assertStoryCapacity(story, limits);
    this.sessions.set(session.id, clone(session));
    this.sessionsByHash.set(session.secretHash, session.id);
    this.stories.set(story.id, clone(story));
  }

  async findSessionBySecretHash(secretHash: string) {
    const id = this.sessionsByHash.get(secretHash);
    const session = id ? this.sessions.get(id) : undefined;
    return session ? clone(session) : undefined;
  }

  async touchSession(id: string, lastSeenAt: Date, expiresAt: Date) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastSeenAt = new Date(lastSeenAt);
    session.expiresAt = new Date(expiresAt);
  }

  async createStory(story: Story) {
    this.stories.set(story.id, clone(story));
  }

  async createStoryAdmitted(story: Story, limits: StoryCreationLimits) {
    await this.assertStoryCapacity(story, limits);
    this.stories.set(story.id, clone(story));
  }

  private async assertStoryCapacity(story: Story, limits: StoryCreationLimits) {
    const recent = [...this.stories.values()].filter(value => value.createdAt >= limits.since);
    if (recent.filter(value => value.ownerSessionId === story.ownerSessionId).length >= limits.sessionStories)
      throw new Error("SESSION_STORY_LIMIT");
    if (story.admissionKey && recent.filter(value => value.admissionKey === story.admissionKey).length >= limits.clientStories)
      throw new Error("CLIENT_STORY_LIMIT");
  }

  async findStory(id: string) {
    const story = this.stories.get(id);
    return story ? clone(story) : undefined;
  }

  async findPublishedStoryBySlug(slug: string) {
    const story = [...this.stories.values()].find(value => value.publicSlug === slug && value.status === "published");
    return story ? clone(story) : undefined;
  }

  async listStories(ownerSessionId: string) {
    return [...this.stories.values()]
      .filter(story => story.ownerSessionId === ownerSessionId && !story.deletedAt)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(story => clone(story));
  }

  async saveStory(story: Story, expectedVersion: number) {
    const current = this.stories.get(story.id);
    if (!current || current.version !== expectedVersion) throw new Error("STORY_VERSION_CONFLICT");
    const saved = clone({ ...story, version: expectedVersion + 1 });
    this.stories.set(saved.id, saved);
    return clone(saved);
  }

  async queueRun(story: Story, run: StoryRun, limits: GenerationLimits) {
    const current = this.stories.get(story.id);
    if (!current || current.version !== story.version) throw new Error("STORY_VERSION_CONFLICT");
    const confirmed = [...this.uploads.values()].filter(value => value.storyId === story.id && value.status === "confirmed");
    if (story.sourceExpiresAt <= limits.now || confirmed.length < limits.minPhotos) throw new Error("SOURCE_NOT_READY");
    const recent = [...this.runs.values()].filter(value => value.updatedAt >= limits.since),
      sessionStoryIds = new Set(
        [...this.stories.values()].filter(value => value.ownerSessionId === story.ownerSessionId).map(value => value.id)
      );
    if (recent.length >= limits.globalStarts) throw new Error("GLOBAL_GENERATION_LIMIT");
    if (recent.filter(value => sessionStoryIds.has(value.storyId)).length >= limits.sessionStarts)
      throw new Error("SESSION_GENERATION_LIMIT");
    if (run.admissionKey && recent.filter(value => value.admissionKey === run.admissionKey).length >= limits.clientStarts)
      throw new Error("CLIENT_GENERATION_LIMIT");
    const queued = clone({ ...story, status: "queued" as const, activeRunId: run.id, version: story.version + 1 });
    this.stories.set(queued.id, queued);
    this.runs.set(run.id, clone(run));
    return clone(queued);
  }

  async createRun(run: StoryRun) {
    this.runs.set(run.id, clone(run));
  }

  async findRun(id: string) {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  async saveRun(run: StoryRun) {
    this.runs.set(run.id, clone(run));
  }

  async completeRun(story: Story, run: StoryRun, manifest: Story["manifest"], now: Date) {
    const currentStory = this.stories.get(story.id),
      currentRun = this.runs.get(run.id);
    if (!currentStory || !currentRun || currentStory.version !== story.version || currentStory.activeRunId !== run.id)
      throw new Error("RUN_STATE_CONFLICT");
    this.stories.set(
      story.id,
      clone({ ...story, status: "draft", manifest, activeRunId: undefined, updatedAt: now, version: story.version + 1 })
    );
    this.runs.set(run.id, clone({ ...run, status: "complete", stage: "complete", progress: 100, finishedAt: now, updatedAt: now }));
  }

  async claimRun(storyId: string, runId: string, now: Date) {
    const story = this.stories.get(storyId),
      run = this.runs.get(runId);
    if (!story || !run || story.activeRunId !== runId) throw new Error("RUN_STATE_CONFLICT");
    if (story.status === "processing" && run.status === "processing") return { story: clone(story), run: clone(run) };
    if (story.status !== "queued" || run.status !== "queued") throw new Error("RUN_STATE_CONFLICT");
    const claimedStory = clone({ ...story, status: "processing" as const, updatedAt: now, version: story.version + 1 }),
      claimedRun = clone({
        ...run,
        status: "processing" as const,
        stage: "curating",
        progress: 5,
        attempts: run.attempts + 1,
        startedAt: run.startedAt ?? now,
        updatedAt: now,
      });
    this.stories.set(storyId, claimedStory);
    this.runs.set(runId, claimedRun);
    return { story: clone(claimedStory), run: clone(claimedRun) };
  }

  async beginDeleteStory(storyId: string, ownerSessionId: string, now: Date) {
    const story = this.stories.get(storyId);
    if (!story || story.ownerSessionId !== ownerSessionId || story.status === "deleted") throw new Error("STORY_NOT_FOUND");
    const deleting = clone({
      ...story,
      status: "deleting" as const,
      publicSlug: undefined,
      activeRunId: undefined,
      updatedAt: now,
      version: story.version + 1,
    });
    this.stories.set(storyId, deleting);
    for (const [id, run] of this.runs)
      if (run.storyId === storyId && (run.status === "queued" || run.status === "processing"))
        this.runs.set(id, { ...run, status: "cancelled", stage: "cancelled", finishedAt: now, updatedAt: now });
    return clone(deleting);
  }

  async finishDeleteStory(storyId: string, now: Date) {
    const story = this.stories.get(storyId);
    if (!story || story.status !== "deleting") throw new Error("STORY_NOT_DELETING");
    this.stories.set(
      storyId,
      clone({ ...story, status: "deleted", manifest: undefined, deletedAt: now, updatedAt: now, version: story.version + 1 })
    );
    for (const [id, upload] of this.uploads)
      if (upload.storyId === storyId) this.uploads.set(id, { ...upload, status: "deleted", deletedAt: now });
  }

  async listRuns(storyId: string) {
    return [...this.runs.values()].filter(value => value.storyId === storyId).map(value => clone(value));
  }

  async expireStaleRuns(now: Date, staleBefore: Date, limit: number) {
    const stale = [...this.runs.values()]
      .filter(value => (value.status === "queued" || value.status === "processing") && value.updatedAt <= staleBefore)
      .slice(0, limit);
    for (const run of stale) {
      const failed = {
        ...run,
        status: "failed" as const,
        stage: "expired",
        errorCode: "PROCESSING_EXPIRED",
        finishedAt: now,
        updatedAt: now,
      };
      this.runs.set(run.id, failed);
      const story = this.stories.get(run.storyId);
      if (story?.activeRunId === run.id)
        this.stories.set(story.id, { ...story, status: "failed", activeRunId: undefined, updatedAt: now, version: story.version + 1 });
    }
    return stale.map(value => clone({ ...value, status: "failed" as const, stage: "expired", finishedAt: now, updatedAt: now }));
  }

  async listRunsForDerivativeCleanup(limit: number) {
    return [...this.runs.values()]
      .filter(value => (value.status === "failed" || value.status === "cancelled") && !value.derivativesDeletedAt)
      .slice(0, limit)
      .map(value => clone(value));
  }

  async markRunDerivativesDeleted(runId: string, now: Date) {
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, derivativesDeletedAt: now, updatedAt: now });
  }

  async createUpload(upload: StoryUpload) {
    this.uploads.set(upload.id, clone(upload));
  }

  async reserveUpload(upload: StoryUpload, limits: UploadLimits) {
    const story = this.stories.get(upload.storyId);
    if (!story || story.status !== "uploading") throw new Error("UPLOAD_STATE_CONFLICT");
    const active = [...this.uploads.values()].filter(
      value => value.storyId === upload.storyId && (value.status === "reserved" || value.status === "confirmed")
    );
    if (active.length >= limits.maxPhotos) throw new Error("UPLOAD_COUNT_LIMIT");
    if (active.reduce((sum, value) => sum + (value.byteSize ?? 0), 0) + (upload.byteSize ?? 0) > limits.maxBytes)
      throw new Error("UPLOAD_BYTES_LIMIT");
    this.uploads.set(upload.id, clone(upload));
  }

  async findUpload(id: string) {
    const upload = this.uploads.get(id);
    return upload ? clone(upload) : undefined;
  }

  async listUploads(storyId: string) {
    return [...this.uploads.values()].filter(upload => upload.storyId === storyId).map(upload => clone(upload));
  }

  async claimExpiredSourceUploads(now: Date, limit: number) {
    const claimed = [...this.uploads.values()]
      .filter(upload => {
        const story = this.stories.get(upload.storyId);
        return (
          (upload.status === "reserved" || upload.status === "confirmed") &&
          !!story &&
          story.status !== "queued" &&
          story.status !== "processing" &&
          story.sourceExpiresAt <= now
        );
      })
      .slice(0, limit)
      .map(upload => clone(upload));
    for (const upload of claimed) this.uploads.set(upload.id, { ...clone(upload), status: "rejected" });
    return claimed.map(upload => ({ ...upload, status: "rejected" as const }));
  }

  async saveUpload(upload: StoryUpload) {
    this.uploads.set(upload.id, clone(upload));
  }

  async confirmUpload(upload: StoryUpload) {
    const story = this.stories.get(upload.storyId),
      current = this.uploads.get(upload.id);
    if (!story || story.status !== "uploading" || !current || current.status !== "reserved") throw new Error("UPLOAD_STATE_CONFLICT");
    this.uploads.set(upload.id, clone(upload));
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
