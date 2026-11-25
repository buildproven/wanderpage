// @design DES-WEB-STORY
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { get, put } from "@vercel/blob";
import exifr from "exifr";
import pLimit from "p-limit";
import sharp from "sharp";
import { z } from "zod";
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";
import {
  LocationPrivacyModes,
  PeopleModes,
  StoryStatuses,
  type CreateStoryInput,
  type OwnerSession,
  type Story,
  type StoryRepository,
  type StoryRun,
  type StoryRunner,
  type StoryUpload,
} from "@/lib/web/types";
import { maxStoryPhotos, minStoryPhotos } from "@/lib/web/limits";
import { currentDisclosureVersion } from "@/lib/consent";
import { applyLocationPrivacy, validateHostedManifestPolicy, validateHostedStoryOutput } from "@/lib/web/processor";

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  peopleMode: z.enum(PeopleModes),
  locationPrivacy: z.enum(LocationPrivacyModes),
  termsVersion: z.literal(currentDisclosureVersion),
  uploadConsentVersion: z.literal(currentDisclosureVersion),
});

const editableStatuses = new Set(["uploading", "draft"]);

/**
 * The operator's generation switches (BUI-2136). `enabled` opens creation to every session (the anonymous web creator);
 * `ownerEnabled` also admits owner sessions while `enabled` is off. Omitted, the owner follows `enabled`. The daily limit binds both.
 */
export type GenerationPolicy = { enabled: boolean; ownerEnabled?: boolean; dailyLimit: number };
const processorRevision = "web-v1";
/**
 * The revision of Claude's curation runs (BUI-2205), distinct from the paid generation's `web-v1` so the generation limits can tell a
 * curation run, which costs no model call, from a generation run.
 */
export const curationRevision = "claude-curation-v1";
/** Curation attempts one story may record in 24 hours; story creation limits bound the stories. */
export const curationAttemptsPerDay = 5;

/**
 * `hidden` and `broad` stories withhold location-bearing text (REQ-LOC-03). The server cannot tell a place name in free text, so it fails
 * closed as generation does (`applyLocationPrivacy`): the page keeps Claude's photos and order and the owner's title, not Claude's text.
 */
export const withholdsCuratedText = (story: Pick<Story, "locationPrivacy">) => story.locationPrivacy !== "approximate";

export class StoryServiceError extends Error {
  constructor(
    readonly code: "AUTH_REQUIRED" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE" | "STORY_VERSION_CONFLICT" | "VALIDATION_ERROR",
    message: string
  ) {
    super(message);
  }
}

/**
 * Private object storage for a story's photos (BUI-2205): Claude's curation reads the source uploads and writes the page derivatives.
 * Default: Vercel Blob, the store the upload and processing paths use.
 */
export type PhotoObjects = {
  read(pathname: string): Promise<Buffer>;
  write(pathname: string, bytes: Buffer): Promise<void>;
};

export const blobPhotoObjects: PhotoObjects = {
  read: async pathname => {
    const object = await get(pathname, { access: "private", useCache: false });
    if (!object || object.statusCode !== 200) throw new Error("A private photo upload is unavailable.");
    return Buffer.from(await new Response(object.stream as never).arrayBuffer());
  },
  write: async (pathname, bytes) => {
    await put(pathname, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/webp",
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
  },
};

/** One photo as Claude sees it: a small metadata-free WebP, the capture date, and a place no finer than city level. */
export type StoryPhoto = {
  id: string;
  captureDate: string | null;
  place: { lat: number; lon: number } | null;
  /** Base64 WebP, at most `thumbnailEdge` pixels on its long side. */
  thumbnail: string;
};

/** Claude's curation of a story (BUI-2205): the chosen photos in page order, a caption for each, and the page text. */
export type CurationInput = {
  title: string;
  intro: string;
  closing?: string;
  photos: Array<{ id: string; caption: string; containsPeople?: boolean }>;
};

export const curationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  intro: z.string().trim().min(1).max(2000),
  closing: z.string().trim().max(2000).optional(),
  photos: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        caption: z.string().trim().min(1).max(300),
        containsPeople: z.boolean().optional(),
      })
    )
    .min(1)
    .max(maxStoryPhotos),
});

/** Statuses whose source uploads still exist, so Claude can read and curate them. */
export const curatableStatuses: ReadonlySet<Story["status"]> = new Set(["uploading", "failed"]);
export const thumbnailEdge = 512;
/** Photos per `get_photos` page, and the base64 image bytes per page: well under the 1 MB a claude.ai tool result may carry. */
const pagePhotoLimit = 12,
  pageImageBudget = 750_000;

export class StoryService {
  constructor(
    private readonly repository: StoryRepository,
    private readonly runner: StoryRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly secretHasher: (secret: string) => string,
    private readonly generationPolicy: () => GenerationPolicy = environmentGenerationPolicy,
    private readonly hostedValidator: typeof validateHostedStoryOutput = validateHostedStoryOutput,
    private readonly photoObjects: PhotoObjects = blobPhotoObjects
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
        kind: "public",
      };
    await this.repository.createSession(session);
    return { session, rawSecret };
  }

  async createSessionWithStory(input: CreateStoryInput, admissionKey: string) {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new StoryServiceError("VALIDATION_ERROR", "Check the story title and privacy choices.");
    this.assertGenerationOpen({ kind: "public" });
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
        kind: "public",
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
    this.assertGenerationOpen(session);
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

  /** Refuses a write step (create, upload, generate) for `session` unless the generation policy admits its kind. */
  assertGenerationOpen(session: Pick<OwnerSession, "kind">, message = "Story creation is temporarily unavailable.") {
    if (!admits(this.generationPolicy(), session)) throw new StoryServiceError("INVALID_STATE", message);
  }

  async getOwnedStory(rawSecret: string, storyId: string) {
    return (await this.getOwnedStoryWithSession(rawSecret, storyId)).story;
  }

  /** `getOwnedStory`, plus the renewed session that owns it, for callers that judge the session's generation policy. */
  async getOwnedStoryWithSession(rawSecret: string, storyId: string) {
    const session = await this.requireSession(rawSecret),
      story = await this.repository.findStory(storyId);
    if (!story || story.deletedAt || story.status === "deleting" || story.status === "deleted")
      throw new StoryServiceError("NOT_FOUND", "Story not found.");
    if (!safeEqual(story.ownerSessionId, session.id))
      throw new StoryServiceError("FORBIDDEN", "This story belongs to another private session.");
    return { session, story };
  }

  /** The confirmed uploads of a story the caller has already read with `getOwnedStory` or `listOwnedStories`. */
  async confirmedPhotoCount(story: Pick<Story, "id">) {
    return (await this.repository.listUploads(story.id)).filter(upload => upload.status === "confirmed").length;
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
    const { session, story } = await this.getOwnedStoryWithSession(rawSecret, storyId);
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
      if (!admits(policy, session)) throw new StoryServiceError("INVALID_STATE", "Story generation is temporarily unavailable.");
      queued = await this.repository.queueRun(
        { ...story, updatedAt: now, processorRevision },
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

  /**
   * One page of a curatable story's confirmed photos, in upload order, for Claude to review (BUI-2205). `cursor` is the `nextCursor` of
   * the page before; the last page's is null. A page stops before its thumbnails would pass `pageImageBudget`.
   */
  async listStoryPhotos(rawSecret: string, storyId: string, cursor?: string | null) {
    const { story } = await this.getOwnedStoryWithSession(rawSecret, storyId);
    this.assertCuratable(story);
    const uploads = await this.confirmedUploads(story.id),
      start = cursor === undefined || cursor === null ? 0 : Number(cursor);
    if (!/^\d+$/.test(cursor ?? "0") || start > uploads.length)
      throw new StoryServiceError("VALIDATION_ERROR", "This photo cursor is not valid. Call get_photos without a cursor to start again.");
    const photos: StoryPhoto[] = [];
    let used = 0,
      index = start;
    for (; index < uploads.length && photos.length < pagePhotoLimit; index += 1) {
      const upload = uploads[index]!,
        source = await this.readSource(upload),
        evidence = await photoEvidence(source),
        thumbnail = (await thumbnailOf(source)).toString("base64");
      if (thumbnail.length > pageImageBudget) throw new Error("A photo thumbnail exceeds the tool result budget.");
      if (photos.length && used + thumbnail.length > pageImageBudget) break;
      used += thumbnail.length;
      photos.push({
        id: upload.id,
        captureDate: evidence.captureTime?.slice(0, 10) ?? null,
        place: cityLevelPlace(evidence.gps, story.locationPrivacy),
        thumbnail,
      });
    }
    return { photos, nextCursor: index < uploads.length ? String(index) : null, total: uploads.length };
  }

  /**
   * Saves Claude's curation as the story's private draft (BUI-2205): metadata-free derivatives of the chosen photos and a manifest with
   * Claude's text. It refuses an unknown or repeated photo id, text that names or identifies a person or gives coordinates, and, in a
   * story that excludes people, any chosen photo Claude did not mark `containsPeople: false` (REQ-SEL-02: fail, do not guess).
   */
  async saveCuration(rawSecret: string, storyId: string, input: CurationInput, admissionKey: string) {
    const parsed = curationSchema.safeParse(input);
    if (!parsed.success)
      throw new StoryServiceError("VALIDATION_ERROR", "Check the curation: a title, intro text, and one caption for each chosen photo.");
    const curation = parsed.data,
      { session, story } = await this.getOwnedStoryWithSession(rawSecret, storyId);
    this.assertGenerationOpen(session, "Story curation is temporarily unavailable.");
    this.assertCuratable(story);
    const ids = curation.photos.map(photo => photo.id),
      repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (repeated.length) throw new StoryServiceError("VALIDATION_ERROR", `Choose each photo once; repeated: ${repeated.join(", ")}.`);
    const uploads = await this.confirmedUploads(story.id),
      byId = new Map(uploads.map(upload => [upload.id, upload])),
      unknown = ids.filter(id => !byId.has(id));
    if (unknown.length)
      throw new StoryServiceError("VALIDATION_ERROR", `These photo ids are not in this story: ${unknown.join(", ")}. Use get_photos ids.`);
    const textErrors = curationTextErrors(curation);
    if (textErrors.length) throw new StoryServiceError("VALIDATION_ERROR", textErrors.join(" "));
    if (story.peopleMode === "exclude") {
      const unsafe = curation.photos.filter(photo => photo.containsPeople !== false);
      if (unsafe.length)
        throw new StoryServiceError(
          "VALIDATION_ERROR",
          "This story excludes people. Every chosen photo needs containsPeople: false. Leave out " +
            unsafe.map(photo => `${photo.id} (${photo.containsPeople ? "shows people" : "containsPeople not given"})`).join(", ") +
            "."
        );
    }
    const now = this.now(),
      since = new Date(now.getTime() - 24 * 60 * 60 * 1000),
      attempts = (await this.repository.listRuns(story.id)).filter(
        run => run.processorRevision === curationRevision && run.admittedAt >= since
      ).length;
    if (attempts >= curationAttemptsPerDay)
      throw new StoryServiceError(
        "INVALID_STATE",
        `This story has used its ${curationAttemptsPerDay} curation attempts for today. Try again after the limit resets.`
      );
    const run: StoryRun = {
      id: randomUUID(),
      storyId: story.id,
      processorRevision: curationRevision,
      admissionKey,
      admittedAt: now,
      status: "processing",
      stage: "curating",
      progress: 0,
      attempts: 1,
      startedAt: now,
      sourceUploadIds: uploads.map(upload => upload.id),
      updatedAt: now,
    };
    // The run is recorded before any derivative is written, so story deletion and failed-run cleanup can find them.
    await this.repository.createRun(run);
    let processing: Story | undefined;
    try {
      const limit = pLimit(2),
        published = await Promise.all(
          curation.photos.map(photo => limit(() => this.publishDerivatives(story.id, run.id, byId.get(photo.id)!)))
        ),
        manifest = curatedManifest(story, curation, published, now),
        policyErrors = validateHostedManifestPolicy(manifest, story.locationPrivacy);
      if (policyErrors.length) throw new StoryServiceError("VALIDATION_ERROR", "The curated story does not satisfy its privacy policy.");
      processing = await this.repository.saveStory(
        { ...story, title: manifest.title, status: "processing", activeRunId: run.id, updatedAt: now },
        story.version
      );
      await this.repository.completeRun(processing, run, manifest, now);
    } catch (error) {
      await this.repository.saveRun({
        ...run,
        status: "failed",
        errorCode: "CURATION_FAILED",
        errorMessage: "Wanderpage could not save the curation.",
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
      if (processing)
        await this.repository.saveStory(
          { ...processing, status: story.status, activeRunId: undefined, updatedAt: this.now() },
          processing.version
        );
      if (error instanceof Error && error.message === "STORY_VERSION_CONFLICT")
        throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed in another tab. Reload and try again.");
      throw error;
    }
    return this.getOwnedStory(rawSecret, storyId);
  }

  private assertCuratable(story: Story) {
    if (!curatableStatuses.has(story.status))
      throw new StoryServiceError("INVALID_STATE", "Only a story that is uploading, or whose generation failed, has photos to curate.");
    if (story.sourceExpiresAt <= this.now())
      throw new StoryServiceError("INVALID_STATE", "These source photos have expired. Start a new private story.");
  }

  private async confirmedUploads(storyId: string) {
    return (await this.repository.listUploads(storyId))
      .filter(upload => upload.status === "confirmed")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  private async readSource(upload: StoryUpload) {
    const bytes = await this.photoObjects.read(upload.blobPath),
      metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 80_000_000)
      throw new StoryServiceError("VALIDATION_ERROR", `Photo ${upload.id} is unreadable or exceeds the 80 megapixel limit.`);
    return bytes;
  }

  /** Large, medium and thumbnail WebP copies of one chosen photo, metadata removed, under the run's derivative prefix. */
  private async publishDerivatives(storyId: string, runId: string, upload: StoryUpload) {
    const source = await this.readSource(upload),
      evidence = await photoEvidence(source),
      // Decode and orient the source once at the largest size; every smaller copy resizes that, not the full original.
      { data: pixels, info: decoded } = await sharp(source)
        .rotate()
        .resize(1800, 1800, { fit: "inside", withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true }),
      image = sharp(pixels, { raw: { width: decoded.width, height: decoded.height, channels: decoded.channels } }),
      sizes = [
        ["large", 1800, 80],
        ["medium", 900, 78],
        ["thumb", 420, 76],
      ] as const,
      paths: Record<string, string> = {};
    let width = 0,
      height = 0;
    for (const [size, edge, quality] of sizes) {
      const { data, info } = await image
        .clone()
        .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
      if (size === "large") ({ width, height } = info);
      const name = `${upload.id}-${size}.webp`;
      await this.photoObjects.write(`derivatives/${storyId}/${curationRevision}/${runId}/${name}`, data);
      paths[size] = `/api/media/${storyId}/${encodeURIComponent(`${curationRevision}--${runId}--${name}`)}`;
    }
    const blur = (await image.clone().resize(24, 24, { fit: "inside" }).webp({ quality: 35 }).toBuffer()).toString("base64");
    return {
      id: upload.id,
      srcLarge: paths.large!,
      srcMedium: paths.medium!,
      srcThumb: paths.thumb!,
      width,
      height,
      blurDataURL: `data:image/webp;base64,${blur}`,
      captureTime: evidence.captureTime,
    };
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
    try {
      return await this.repository.saveStory(
        {
          ...story,
          status: "published",
          publicSlug: story.publicSlug ?? `${slug(story.title)}-${randomBytes(5).toString("hex")}`,
          publishedAt: this.now(),
          updatedAt: this.now(),
        },
        story.version
      );
    } catch (error) {
      throw publicationError(error);
    }
  }

  async unpublish(rawSecret: string, storyId: string) {
    const story = await this.getOwnedStory(rawSecret, storyId);
    if (story.status !== "published") throw new StoryServiceError("INVALID_STATE", "Only a published story can be unpublished.");
    try {
      return await this.repository.saveStory({ ...story, status: "draft", updatedAt: this.now() }, story.version);
    } catch (error) {
      throw publicationError(error);
    }
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

function publicationError(error: unknown) {
  if (error instanceof Error && error.message === "STORY_VERSION_CONFLICT")
    return new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed in another tab. Reload and try again.");
  return error;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("WANDERPAGE_DAILY_GENERATION_LIMIT must be a positive integer.");
  return parsed;
}

function environmentGenerationPolicy(): GenerationPolicy {
  return {
    enabled: process.env.WANDERPAGE_GENERATION_ENABLED === "true",
    ownerEnabled: ownerSwitch(process.env.WANDERPAGE_OWNER_GENERATION_ENABLED),
    dailyLimit: positiveInteger(process.env.WANDERPAGE_DAILY_GENERATION_LIMIT, 25),
  };
}

/** Owner generation is on unless the operator sets `WANDERPAGE_OWNER_GENERATION_ENABLED=false`; any other value is a visible error. */
function ownerSwitch(value: string | undefined) {
  if (value === undefined || value === "" || value === "true") return true;
  if (value === "false") return false;
  throw new Error("WANDERPAGE_OWNER_GENERATION_ENABLED must be true or false when set.");
}

/** Public creation admits every session; owner generation also admits owner sessions while public creation is off. */
function admits(policy: GenerationPolicy, session: Pick<OwnerSession, "kind">) {
  if (policy.enabled) return true;
  return session.kind === "owner" && (policy.ownerEnabled ?? policy.enabled);
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

/**
 * Text that names or identifies a person (BUI-2205, SN-02): a title with a name, a relationship, a handle or an email. A bare first
 * name cannot be told from a place name, so the skill's privacy rule stays the first guard; this catches what text can show.
 */
const personPatterns: Array<[RegExp, string]> = [
  [/\b(?:Mr|Mrs|Ms|Mx|Dr|Miss|Sir|Madam|Mme|Mlle|Herr|Frau|Señora?|Senhora?|Signora?)\.?\s+\p{Lu}/u, "names a person by title"],
  [
    /\b(?:my|our|his|her|their)\s+(?:wife|husband|partner|spouse|sons?|daughters?|kids?|child(?:ren)?|bab(?:y|ies)|mother|father|mom|mum|dad|parents?|brothers?|sisters?|siblings?|friends?|boyfriend|girlfriend|fianc[eé]e?|grand(?:ma|pa|mother|father|sons?|daughters?|parents?|kids?|children)|aunts?|uncles?|cousins?|nieces?|nephews?|family)(?![\p{L}\p{N}])/iu,
    "identifies a person by relationship",
  ],
  [
    /\b(?:my|our|his|her|their)\s+(?:boss|colleagues?|co-?workers?|neighbou?rs?|room-?mates?|flat-?mates?|teachers?|classmates?)(?![\p{L}\p{N}])/iu,
    "identifies a person by relationship",
  ],
  [/(?:^|[\s(])@[\p{L}\p{N}_.]{2,}/u, "names a person by handle"],
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u, "contains an email address"],
];
/**
 * Common given names, written capitalized, that are not also common place names or ordinary words (no Victoria, Florence, Jordan,
 * May, Rose, Grace). A name after a saint or place prefix (San Diego, St. Mary's, Lake George) or before a place word (Charles Bridge)
 * is a place, not a person.
 */
const givenNames = new Set(
  (
    "john james robert michael william david richard joseph thomas christopher daniel matthew anthony steven andrew paul joshua kevin " +
    "brian edward ryan jacob nicholas eric jonathan stephen justin brandon benjamin samuel gregory patrick peter henry adam nathan " +
    "zachary kyle noah ethan lucas liam oliver elijah mason aiden leo luca marco giovanni giuseppe francesco antonio alessandro pierre " +
    "jean louis luis carlos juan miguel pedro jose josé joão pablo diego javier hans klaus stefan lars sven mohammed muhammad ahmed " +
    "omar hiroshi kenji raj arjun ivan dmitri mary patricia jennifer linda barbara susan jessica sarah karen nancy lisa betty margaret " +
    "sandra ashley kimberly emily donna michelle carol amanda melissa deborah stephanie rebecca laura sharon cynthia kathleen amy " +
    "shirley angela anna emma olivia ava isabella mia amelia evelyn abigail ella scarlett chloe zoe lucy sofia maria marie giulia " +
    "francesca chiara sophie claire camille léa ana carmen lucia elena ingrid astrid fatima aisha yuki priya olga natasha tom tim " +
    "sam joe dan nick alex kate katie jane liz beth meg ellie tommy bobby bob mike steve dave chris matt jenny emilia hannah julia"
  ).split(" ")
);
const placePrefix =
  /^(?:San|Santa|Santo|São|Sao|St\.?|Saint|Ste\.?|Sainte|Port|Fort|Lake|Mount|Mt\.?|Cape|Monte|Porto|Puerto|Rio|Río|Villa|Ciudad|Isla|Île|Sankt|King|Queen|Prince|Princess)$/u;
const placeWord =
  /^(?:Street|St|Road|Rd|Avenue|Ave|Square|Bridge|Island|Bay|Park|Lake|Hill|Church|Cathedral|Chapel|Basilica|Station|Gate|Tower|Beach|Falls|Point|Market|Palace|Castle|Museum|Hall|Gardens?|River|Town|Harbou?r|Quay|Pier|Lane|Way|Place|Boulevard|Fort|Abbey|Monastery|Valley|Peak|Strait|Sound)$/u;

/** The first given name in `text` that reads as a person, not part of a place name. */
function namedPerson(text: string) {
  const words = [...text.matchAll(/[\p{L}][\p{L}'’.]*/gu)].map(match => match[0]);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!,
      bare = word.replace(/(?:['’]s|['’.])+$/u, "");
    if (!/^\p{Lu}\p{Ll}+$/u.test(bare) || !givenNames.has(bare.toLowerCase())) continue;
    const before = words[index - 1] ?? "",
      after = (words[index + 1] ?? "").replace(/[.'’]+$/u, "");
    if (placePrefix.test(before) || placeWord.test(after)) continue;
    return bare;
  }
  return undefined;
}

const coordinatePattern = /-?\d{1,3}\.\d{2,}\s*°?\s*[NSEW]?\s*[,;/ ]\s*-?\d{1,3}\.\d{2,}|\d{1,3}\s*°\s*\d{1,2}\s*['′]/iu;

function curationTextErrors(curation: z.infer<typeof curationSchema>) {
  const fields: Array<[string, string | undefined]> = [
    ["The title", curation.title],
    ["The intro", curation.intro],
    ["The closing", curation.closing],
    ...curation.photos.map(photo => [`The caption of photo ${photo.id}`, photo.caption] as [string, string]),
  ];
  return fields.flatMap(([field, text]) => {
    if (!text) return [];
    const problems = personPatterns.filter(([pattern]) => pattern.test(text)).map(([, problem]) => problem),
      name = namedPerson(text);
    if (name) problems.push(`names a person (${name})`);
    if (coordinatePattern.test(text)) problems.push("gives coordinates");
    return problems.length ? [`${field} ${problems.join(" and ")}; describe scenes and places, not people or exact positions.`] : [];
  });
}

/** The capture time as written in the photo (local time, no zone) and its GPS position; either may be missing. */
async function photoEvidence(bytes: Buffer) {
  const exif = (await exifr.parse(bytes, { exif: true, tiff: true, reviveValues: false }).catch(() => undefined)) as
      { DateTimeOriginal?: unknown } | undefined,
    gps = (await exifr.gps(bytes).catch(() => undefined)) as { latitude?: unknown; longitude?: unknown } | undefined,
    match =
      typeof exif?.DateTimeOriginal === "string" ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(exif.DateTimeOriginal) : null,
    validDate = match && Number(match[1]) > 1900 && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[3]) >= 1;
  return {
    captureTime: validDate ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : undefined,
    gps:
      typeof gps?.latitude === "number" && typeof gps.longitude === "number" && Number.isFinite(gps.latitude + gps.longitude)
        ? { lat: gps.latitude, lon: gps.longitude }
        : undefined,
  };
}

/** Never the exact position: about 11 km (city level) for `approximate`, whole degrees for `broad`, nothing for `hidden`. */
function cityLevelPlace(gps: { lat: number; lon: number } | undefined, privacy: Story["locationPrivacy"]) {
  if (!gps || privacy === "hidden") return null;
  const round = (value: number) => (privacy === "broad" ? Math.round(value) : Math.round(value * 10) / 10) + 0;
  return { lat: round(gps.lat), lon: round(gps.lon) };
}

function thumbnailOf(bytes: Buffer) {
  return sharp(bytes)
    .rotate()
    .resize(thumbnailEdge, thumbnailEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();
}

type CuratedPhoto = Awaited<ReturnType<StoryService["publishDerivatives"]>>;

/**
 * The draft manifest of Claude's curation: no destinations, route or coordinates; chapters follow the chosen order by capture day. A
 * `hidden` or `broad` story keeps the owner's title and gets the generation path's location-free text instead of Claude's.
 */
function curatedManifest(story: Story, curation: z.infer<typeof curationSchema>, published: CuratedPhoto[], now: Date): TripManifest {
  const chosen = curation.photos.map((photo, index) => ({
      ...photo,
      ...published[index]!,
      date: published[index]!.captureTime?.slice(0, 10),
    })),
    runs: Array<{ date?: string; photoIds: string[] }> = [];
  for (const photo of chosen) {
    const last = runs.at(-1);
    if (last && last.date === photo.date) last.photoIds.push(photo.id);
    else runs.push({ date: photo.date, photoIds: [photo.id] });
  }
  const dates = [...new Set(chosen.flatMap(photo => (photo.date ? [photo.date] : [])))].sort(),
    dateRange = dates.length ? { start: dates[0]!, end: dates.at(-1)! } : undefined,
    layouts = ["split", "editorial", "mosaic", "filmstrip"] as const;
  const manifest = TripManifestSchema.parse({
    schemaVersion: "1.0",
    generatedAt: now.toISOString(),
    published: false,
    title: withholdsCuratedText(story) ? story.title : curation.title,
    subtitle: dateRange
      ? dateRange.start === dateRange.end
        ? longDate(dateRange.start)
        : `${longDate(dateRange.start)} to ${longDate(dateRange.end)}`
      : "",
    opening: curation.intro,
    closing: curation.closing ?? "",
    dateRange,
    peopleMode: story.peopleMode,
    theme: { background: "#f2eee5", foreground: "#17211f", accent: "#c76542", muted: "#a4aca5" },
    heroPhotoId: chosen[0]!.id,
    stats: [
      { label: "Days", value: String(dates.length || 1) },
      { label: "Selected frames", value: String(chosen.length) },
    ],
    destinations: [],
    route: [],
    chapters: runs.map((run, index) => ({
      id: `chapter-${index + 1}`,
      title: run.date ? longDate(run.date) : "More photographs",
      date: run.date,
      narrative: "",
      photoIds: run.photoIds,
      layout: layouts[index % layouts.length],
    })),
    photos: chosen.map(photo => ({
      id: photo.id,
      srcLarge: photo.srcLarge,
      srcMedium: photo.srcMedium,
      srcThumb: photo.srcThumb,
      width: photo.width,
      height: photo.height,
      blurDataURL: photo.blurDataURL,
      alt: photo.caption,
      caption: photo.caption,
      captureTime: photo.captureTime,
      // Only a value Claude sent; unknown counts as showing people, never as not (REQ-SEL-02).
      containsPeople: photo.containsPeople ?? true,
      source: "user",
    })),
    sources: [],
  });
  return withholdsCuratedText(story) ? TripManifestSchema.parse(applyLocationPrivacy(manifest, story.locationPrivacy)) : manifest;
}

function longDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`)
  );
}

void StoryStatuses;
