import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  LocationPrivacyModes,
  PeopleModes,
  StoryStatuses,
  type CreateStoryInput,
  type OwnerSession,
  type Story,
  type StoryRepository,
  type StoryRunner,
} from "@/lib/web/types";
import { minStoryPhotos } from "@/lib/web/limits";

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  peopleMode: z.enum(PeopleModes),
  locationPrivacy: z.enum(LocationPrivacyModes),
  termsVersion: z.string().trim().min(1).max(64),
  uploadConsentVersion: z.string().trim().min(1).max(64),
});

const editableStatuses = new Set(["uploading", "draft"]);
const processorRevision = "web-v1";

export class StoryServiceError extends Error {
  constructor(
    readonly code: "AUTH_REQUIRED" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE" | "STORY_VERSION_CONFLICT" | "VALIDATION_ERROR",
    message: string
  ) {
    super(message);
  }
}

export class StoryService {
  constructor(
    private readonly repository: StoryRepository,
    private readonly runner: StoryRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly secretHasher: (secret: string) => string,
    private readonly generationPolicy: () => { enabled: boolean; dailyLimit: number } = environmentGenerationPolicy
  ) {}

  async createSession({ termsVersion, uploadConsentVersion }: Pick<CreateStoryInput, "termsVersion" | "uploadConsentVersion">) {
    const now = this.now(),
      rawSecret = randomBytes(32).toString("base64url"),
      session: OwnerSession = {
        id: randomUUID(),
        secretHash: this.secretHasher(rawSecret),
        csrfToken: randomBytes(32).toString("base64url"),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        termsVersion,
        uploadConsentVersion,
      };
    await this.repository.createSession(session);
    return { session, rawSecret };
  }

  async requireSession(rawSecret: string | undefined) {
    if (!rawSecret) throw new StoryServiceError("AUTH_REQUIRED", "Your private Wanderpage session is missing.");
    const session = await this.repository.findSessionBySecretHash(this.secretHasher(rawSecret));
    if (!session || session.revokedAt || session.expiresAt <= this.now())
      throw new StoryServiceError("AUTH_REQUIRED", "Your private Wanderpage session has expired.");
    await this.repository.touchSession(session.id, this.now());
    return session;
  }

  async createStory(rawSecret: string, input: CreateStoryInput) {
    const session = await this.requireSession(rawSecret),
      parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new StoryServiceError("VALIDATION_ERROR", "Check the story title and privacy choices.");
    if (session.termsVersion !== parsed.data.termsVersion || session.uploadConsentVersion !== parsed.data.uploadConsentVersion)
      throw new StoryServiceError("VALIDATION_ERROR", "Please start a new session after accepting the current upload terms.");
    const now = this.now(),
      story: Story = {
        id: randomUUID(),
        ownerSessionId: session.id,
        status: "uploading",
        title: parsed.data.title,
        peopleMode: parsed.data.peopleMode,
        locationPrivacy: parsed.data.locationPrivacy,
        processorRevision,
        sourceExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
    await this.repository.createStory(story);
    return story;
  }

  async getOwnedStory(rawSecret: string, storyId: string) {
    const session = await this.requireSession(rawSecret),
      story = await this.repository.findStory(storyId);
    if (!story || story.deletedAt) throw new StoryServiceError("NOT_FOUND", "Story not found.");
    if (!safeEqual(story.ownerSessionId, session.id))
      throw new StoryServiceError("FORBIDDEN", "This story belongs to another private session.");
    return story;
  }

  async listOwnedStories(rawSecret: string) {
    const session = await this.requireSession(rawSecret);
    return this.repository.listStories(session.id);
  }

  async updateStory(
    rawSecret: string,
    storyId: string,
    expectedVersion: number,
    changes: Pick<Story, "title" | "peopleMode" | "locationPrivacy">
  ) {
    const story = await this.getOwnedStory(rawSecret, storyId);
    if (!editableStatuses.has(story.status))
      throw new StoryServiceError("INVALID_STATE", "This story cannot be edited while it is processing or published.");
    if (story.version !== expectedVersion)
      throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed in another tab. Reload and try again.");
    const parsed = createSchema.safeParse({ ...changes, termsVersion: "existing", uploadConsentVersion: "existing" });
    if (!parsed.success) throw new StoryServiceError("VALIDATION_ERROR", "Check the story title and privacy choices.");
    try {
      const policyChanged = story.peopleMode !== changes.peopleMode || story.locationPrivacy !== changes.locationPrivacy;
      return await this.repository.saveStory(
        {
          ...story,
          ...changes,
          status: policyChanged && story.status === "draft" ? "uploading" : story.status,
          manifest: policyChanged ? undefined : story.manifest,
          updatedAt: this.now(),
        },
        expectedVersion
      );
    } catch (error) {
      if (error instanceof Error && error.message === "STORY_VERSION_CONFLICT")
        throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed in another tab. Reload and try again.");
      throw error;
    }
  }

  async queueGeneration(rawSecret: string, storyId: string, admissionKey: string) {
    const story = await this.getOwnedStory(rawSecret, storyId);
    if (story.status !== "uploading" && story.status !== "failed")
      throw new StoryServiceError("INVALID_STATE", "This story is already queued or cannot be generated.");
    const confirmedUploads = (await this.repository.listUploads(story.id)).filter(upload => upload.status === "confirmed");
    if (confirmedUploads.length < minStoryPhotos)
      throw new StoryServiceError("VALIDATION_ERROR", `Add at least ${minStoryPhotos} completed photos before generating a story.`);
    const now = this.now(),
      runId = randomUUID();
    let queued: Story;
    try {
      const policy = this.generationPolicy();
      if (!policy.enabled) throw new StoryServiceError("INVALID_STATE", "Story generation is temporarily unavailable.");
      queued = await this.repository.queueRun(
        { ...story, updatedAt: now, processorRevision },
        {
          id: runId,
          storyId: story.id,
          processorRevision,
          admissionKey,
          status: "queued",
          stage: "queued",
          progress: 0,
          attempts: 0,
          updatedAt: now,
        },
        { sessionStarts: 3, clientStarts: 6, globalStarts: policy.dailyLimit, since: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
      );
    } catch (error) {
      if (error instanceof Error && error.message === "STORY_VERSION_CONFLICT")
        throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed in another tab. Reload and try again.");
      if (
        error instanceof Error &&
        ["GLOBAL_GENERATION_LIMIT", "SESSION_GENERATION_LIMIT", "CLIENT_GENERATION_LIMIT"].includes(error.message)
      )
        throw new StoryServiceError("INVALID_STATE", "The story generation limit has been reached. Try again after the limit resets.");
      throw error;
    }
    try {
      const started = await this.runner.start(queued.id, runId),
        run = await this.repository.findRun(runId);
      if (run) await this.repository.saveRun({ ...run, workflowRunId: started.workflowRunId, updatedAt: this.now() });
    } catch (error) {
      const run = await this.repository.findRun(runId);
      if (run)
        await this.repository.saveRun({
          ...run,
          status: "failed",
          stage: "admission",
          errorCode: "PROCESSING_ADMISSION_FAILED",
          errorMessage: "Wanderpage could not start generation. Please try again.",
          finishedAt: this.now(),
          updatedAt: this.now(),
        });
      await this.repository.saveStory({ ...queued, status: "failed", activeRunId: undefined, updatedAt: this.now() }, queued.version);
      throw error;
    }
    return queued;
  }

  async publish(rawSecret: string, storyId: string) {
    const story = await this.getOwnedStory(rawSecret, storyId);
    if (story.status !== "draft" || !story.manifest)
      throw new StoryServiceError("INVALID_STATE", "Finish a private draft before publishing.");
    return this.repository.saveStory(
      {
        ...story,
        status: "published",
        publicSlug: story.publicSlug ?? `${slug(story.title)}-${randomBytes(5).toString("hex")}`,
        publishedAt: this.now(),
        updatedAt: this.now(),
      },
      story.version
    );
  }

  async unpublish(rawSecret: string, storyId: string) {
    const story = await this.getOwnedStory(rawSecret, storyId);
    if (story.status !== "published") throw new StoryServiceError("INVALID_STATE", "Only a published story can be unpublished.");
    return this.repository.saveStory({ ...story, status: "draft", updatedAt: this.now() }, story.version);
  }
}

export function hashSecret(secret: string, pepper: string) {
  if (!pepper) throw new Error("WANDERPAGE_SESSION_PEPPER is required to hash owner sessions.");
  return createHmac("sha256", pepper).update(secret).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "wanderpage"
  );
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("WANDERPAGE_DAILY_GENERATION_LIMIT must be a positive integer.");
  return parsed;
}

function environmentGenerationPolicy() {
  return {
    enabled: process.env.WANDERPAGE_GENERATION_ENABLED === "true",
    dailyLimit: positiveInteger(process.env.WANDERPAGE_DAILY_GENERATION_LIMIT, 25),
  };
}

void StoryStatuses;
