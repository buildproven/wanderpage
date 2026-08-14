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
import { currentDisclosureVersion } from "@/lib/consent";
import { validateHostedManifestPolicy, validateHostedStoryOutput } from "@/lib/web/processor";

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  peopleMode: z.enum(PeopleModes),
  locationPrivacy: z.enum(LocationPrivacyModes),
  termsVersion: z.literal(currentDisclosureVersion),
  uploadConsentVersion: z.literal(currentDisclosureVersion),
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
    private readonly generationPolicy: () => { enabled: boolean; dailyLimit: number } = environmentGenerationPolicy,
    private readonly hostedValidator: typeof validateHostedStoryOutput = validateHostedStoryOutput
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

  async createSessionWithStory(input: CreateStoryInput, admissionKey: string) {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new StoryServiceError("VALIDATION_ERROR", "Check the story title and privacy choices.");
    this.assertGenerationOpen();
    const now = this.now(),
      rawSecret = randomBytes(32).toString("base64url"),
      session: OwnerSession = {
        id: randomUUID(),
        secretHash: this.secretHasher(rawSecret),
        csrfToken: randomBytes(32).toString("base64url"),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        termsVersion: parsed.data.termsVersion,
        uploadConsentVersion: parsed.data.uploadConsentVersion,
      },
      story = makeStory(session.id, admissionKey, parsed.data, now);
    try {
      await this.repository.createSessionAndStoryAdmitted(session, story, storyLimits(now));
    } catch (error) {
      if (error instanceof Error && error.message === "CLIENT_STORY_LIMIT")
        throw new StoryServiceError("INVALID_STATE", "The private story creation limit has been reached. Try again after it resets.");
      throw error;
    }
    return { session, story, rawSecret };
  }

  async requireSession(rawSecret: string | undefined) {
    if (!rawSecret) throw new StoryServiceError("AUTH_REQUIRED", "Your private Wanderpage session is missing.");
    const now = this.now(),
      renewed = await this.repository.renewSession(this.secretHasher(rawSecret), now, new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
    if (!renewed) throw new StoryServiceError("AUTH_REQUIRED", "Your private Wanderpage session has expired.");
    return renewed;
  }

  async createStory(rawSecret: string, input: CreateStoryInput, admissionKey = "test-client") {
    const session = await this.requireSession(rawSecret),
      parsed = createSchema.safeParse(input);
    this.assertGenerationOpen();
    if (!parsed.success) throw new StoryServiceError("VALIDATION_ERROR", "Check the story title and privacy choices.");
    if (session.termsVersion !== parsed.data.termsVersion || session.uploadConsentVersion !== parsed.data.uploadConsentVersion)
      throw new StoryServiceError("VALIDATION_ERROR", "Please start a new session after accepting the current upload terms.");
    const now = this.now(),
      story = makeStory(session.id, admissionKey, parsed.data, now);
    try {
      await this.repository.createStoryAdmitted(story, storyLimits(now));
    } catch (error) {
      if (error instanceof Error && ["SESSION_STORY_LIMIT", "CLIENT_STORY_LIMIT"].includes(error.message))
        throw new StoryServiceError("INVALID_STATE", "The private story creation limit has been reached. Try again after it resets.");
      throw error;
    }
    return story;
  }

  assertGenerationOpen() {
    if (!this.generationPolicy().enabled) throw new StoryServiceError("INVALID_STATE", "Story creation is temporarily unavailable.");
  }

  async getOwnedStory(rawSecret: string, storyId: string) {
    const session = await this.requireSession(rawSecret),
      story = await this.repository.findStory(storyId);
    if (!story || story.deletedAt || story.status === "deleting" || story.status === "deleted")
      throw new StoryServiceError("NOT_FOUND", "Story not found.");
    if (!safeEqual(story.ownerSessionId, session.id))
      throw new StoryServiceError("FORBIDDEN", "This story belongs to another private session.");
    return story;
  }

  async listOwnedStories(rawSecret: string) {
    const session = await this.requireSession(rawSecret);
    return (await this.repository.listStories(session.id)).filter(story => story.status !== "deleting" && story.status !== "deleted");
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
    const parsed = createSchema.safeParse({
      ...changes,
      termsVersion: currentDisclosureVersion,
      uploadConsentVersion: currentDisclosureVersion,
    });
    if (!parsed.success) throw new StoryServiceError("VALIDATION_ERROR", "Check the story title and privacy choices.");
    try {
      const policyChanged = story.peopleMode !== changes.peopleMode || story.locationPrivacy !== changes.locationPrivacy;
      if (policyChanged && story.status === "draft")
        throw new StoryServiceError(
          "INVALID_STATE",
          "A completed draft cannot change its privacy policy after source deletion. Start a new private story with the new policy."
        );
      const candidate = {
        ...story,
        ...changes,
        status: story.status,
        manifest: policyChanged ? undefined : story.manifest ? { ...story.manifest, title: changes.title } : undefined,
        updatedAt: this.now(),
      };
      if (candidate.manifest) {
        const errors = validateHostedManifestPolicy(candidate.manifest, candidate.locationPrivacy);
        if (errors.length) throw new StoryServiceError("VALIDATION_ERROR", "The edited story does not satisfy its privacy policy.");
      }
      return await this.repository.saveStory(candidate, expectedVersion);
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
    if (story.sourceExpiresAt <= this.now())
      throw new StoryServiceError("INVALID_STATE", "These source photos have expired. Start a new private story.");
    if (confirmedUploads.length < minStoryPhotos)
      throw new StoryServiceError("VALIDATION_ERROR", `Add at least ${minStoryPhotos} completed photos before generating a story.`);
    const now = this.now(),
      runId = randomUUID();
    let queued: Story;
    try {
      const policy = this.generationPolicy();
      if (!policy.enabled) throw new StoryServiceError("INVALID_STATE", "Story generation is temporarily unavailable.");
      queued = await this.repository.queueRun(
        { ...story, sourceExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), updatedAt: now, processorRevision },
        {
          id: runId,
          storyId: story.id,
          processorRevision,
          admissionKey,
          admittedAt: now,
          status: "queued",
          stage: "queued",
          progress: 0,
          attempts: 0,
          sourceUploadIds: [],
          updatedAt: now,
        },
        {
          sessionStarts: 3,
          clientStarts: 6,
          globalStarts: policy.dailyLimit,
          since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          now,
          minPhotos: minStoryPhotos,
        }
      );
    } catch (error) {
      if (error instanceof Error && error.message === "STORY_VERSION_CONFLICT")
        throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed in another tab. Reload and try again.");
      if (
        error instanceof Error &&
        ["GLOBAL_GENERATION_LIMIT", "SESSION_GENERATION_LIMIT", "CLIENT_GENERATION_LIMIT"].includes(error.message)
      )
        throw new StoryServiceError("INVALID_STATE", "The story generation limit has been reached. Try again after the limit resets.");
      if (error instanceof Error && error.message === "SOURCE_NOT_READY")
        throw new StoryServiceError("INVALID_STATE", "The source photos are incomplete or expired. Start a new private story.");
      throw error;
    }
    try {
      const started = await this.runner.start(queued.id, runId),
        run = await this.repository.findRun(runId);
      if (run) await this.repository.setWorkflowRunId(run.id, started.workflowRunId, this.now());
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
    const runId = hostedRunId(story);
    if (!runId) throw new StoryServiceError("INVALID_STATE", "This draft does not have valid hosted media.");
    try {
      await this.hostedValidator(story.id, runId, story.manifest, story.locationPrivacy);
    } catch {
      throw new StoryServiceError("INVALID_STATE", "This draft failed its final privacy validation and cannot be published.");
    }
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

  async prepareDelete(rawSecret: string, storyId: string) {
    const session = await this.requireSession(rawSecret),
      story = await this.repository.findStory(storyId);
    if (!story || !safeEqual(story.ownerSessionId, session.id)) throw new StoryServiceError("NOT_FOUND", "Story not found.");
    if (story.status === "deleted") return { story, alreadyDeleted: true };
    return { story: await this.repository.beginDeleteStory(storyId, session.id, this.now()), alreadyDeleted: false };
  }

  async finishDelete(storyId: string) {
    await this.repository.finishDeleteStory(storyId, this.now());
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

function hostedRunId(story: Story) {
  const path = story.manifest?.photos[0]?.srcLarge;
  if (!path) return undefined;
  const [, runId] = decodeURIComponent(path.split("/").at(-1) ?? "").split("--");
  return runId || undefined;
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

function makeStory(ownerSessionId: string, admissionKey: string, input: CreateStoryInput, now: Date): Story {
  return {
    id: randomUUID(),
    ownerSessionId,
    admissionKey,
    status: "uploading",
    title: input.title,
    peopleMode: input.peopleMode,
    locationPrivacy: input.locationPrivacy,
    processorRevision,
    sourceExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function storyLimits(now: Date) {
  return { sessionStories: 3, clientStories: 6, since: new Date(now.getTime() - 24 * 60 * 60 * 1000) };
}

void StoryStatuses;
