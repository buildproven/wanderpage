// @design DES-WEB-STORY
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { del, get, put } from "@vercel/blob";
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

/**
 * The operator's generation switches (BUI-2136). `enabled` opens creation to every session (the anonymous web creator);
 * `ownerEnabled` also admits owner sessions while `enabled` is off. Omitted, the owner follows `enabled`. The daily limit binds both.
 */
export type GenerationPolicy = { enabled: boolean; ownerEnabled?: boolean; dailyLimit: number };
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
    private readonly generationPolicy: () => GenerationPolicy = environmentGenerationPolicy,
    private readonly hostedValidator: typeof validateHostedStoryOutput = validateHostedStoryOutput,
    private readonly objects: StoryObjects = blobObjects
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

  /**
   * One page of a story's uploaded photos for Claude to review (BUI-2205): small WebP thumbnails without metadata, each photo's capture
   * time and a place no finer than the story's location privacy (city level for approximate, never the exact GPS), and the next cursor.
   * A page holds at most `photoPageSize` photos and `photoPageBudget` characters of image data, so one tool result stays under 1 MB.
   */
  async getPhotos(rawSecret: string, storyId: string, cursor?: string): Promise<PhotoPage> {
    const story = await this.getOwnedStory(rawSecret, storyId);
    this.assertSourcesStored(story, "get_photos");
    const uploads = await this.storedUploads(story),
      offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || (cursor !== undefined && offset >= uploads.length))
      throw new StoryServiceError(
        "VALIDATION_ERROR",
        `The cursor "${cursor}" is not a page of this story's ${uploads.length} photos. Call get_photos without a cursor to start again.`
      );
    const limit = pLimit(4),
      candidates = await Promise.all(
        uploads.slice(offset, offset + photoPageSize).map(upload => limit(() => this.reviewPhoto(upload, story.locationPrivacy)))
      ),
      photos: ReviewPhoto[] = [];
    let used = 0;
    // A 384-pixel WebP is far below the budget, so the first photo always fits and every page moves the cursor on.
    for (const photo of candidates) {
      if (photos.length && used + photo.image.length > photoPageBudget) break;
      photos.push(photo);
      used += photo.image.length;
    }
    const next = offset + photos.length;
    return { storyId: story.id, total: uploads.length, photos, nextCursor: next < uploads.length ? String(next) : null };
  }

  /**
   * Saves Claude's curation as the story's draft (BUI-2205): the chosen photos in order, a caption for each, the title and the intro.
   * From a story whose originals are stored it builds the page's WebP derivatives under a new run, completes the run as a draft and
   * removes the originals, as generation does. Over an existing draft it reuses the draft's stored photos. It rejects a photo ID that is
   * not in the story, a repeated ID, a stale version, and text that names or identifies a person, and then changes nothing.
   */
  async saveCuration(rawSecret: string, storyId: string, input: CurationInput, admissionKey: string) {
    const { session, story } = await this.getOwnedStoryWithSession(rawSecret, storyId),
      parsed = curationSchema.safeParse(input);
    if (!parsed.success)
      throw new StoryServiceError("VALIDATION_ERROR", `Check the curation: ${parsed.error.issues.map(issue => issue.message).join("; ")}.`);
    const curation = parsed.data,
      repeated = [...new Set(curation.photos.map(photo => photo.id).filter((id, index, ids) => ids.indexOf(id) !== index))];
    if (repeated.length)
      throw new StoryServiceError("VALIDATION_ERROR", `Each photo can be chosen once; chosen more than once: ${repeated.join(", ")}.`);
    const personText = identifyingText(curation);
    if (personText)
      throw new StoryServiceError(
        "VALIDATION_ERROR",
        `The ${personText.field} names or identifies a person ("${personText.match}"). Describe scenes and places, not people.`
      );
    if (story.status === "published")
      throw new StoryServiceError("INVALID_STATE", "This story is published. Unpublish it before you save a new curation.");
    if (curation.version !== undefined && story.version !== curation.version)
      throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed in another tab. Reload and try again.");
    if (story.status === "draft" && story.manifest) return this.recurate(story, story.manifest, curation);
    this.assertSourcesStored(story, "save_curation");
    this.assertGenerationOpen(session);
    const uploads = await this.storedUploads(story),
      byId = new Map(uploads.map(upload => [upload.id, upload])),
      unknown = curation.photos.filter(photo => !byId.has(photo.id)).map(photo => photo.id);
    if (unknown.length) throw new StoryServiceError("VALIDATION_ERROR", `These photo IDs are not in this story: ${unknown.join(", ")}.`);
    return this.buildCuratedDraft(story, uploads, byId, curation, admissionKey);
  }

  /** Refuses `tool` unless the story's original photos are still stored: while it is uploading, or failed before its sources expired. */
  private assertSourcesStored(story: Story, tool: string) {
    if (story.status !== "uploading" && story.status !== "failed")
      throw new StoryServiceError(
        "INVALID_STATE",
        `${tool} refused: "${story.title}" is ${story.status}. Its original photos are read only before its draft is made; ` +
          (story.status === "draft" ? "save_curation can still change the draft from its stored photos." : "wait for it to finish.")
      );
    if (story.sourceExpiresAt <= this.now())
      throw new StoryServiceError("INVALID_STATE", "These source photos have expired. Start a new private story.");
  }

  /** The story's confirmed uploads in upload order, so a cursor stays valid while more photos arrive. */
  private async storedUploads(story: Story) {
    return (await this.repository.listUploads(story.id))
      .filter(upload => upload.status === "confirmed")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  private async reviewPhoto(upload: StoryUpload, privacy: Story["locationPrivacy"]): Promise<ReviewPhoto> {
    const bytes = await this.objects.read(upload.blobPath),
      [thumbnail, details] = await Promise.all([
        // sharp writes no EXIF, XMP or ICC metadata unless asked, so the thumbnail carries no GPS.
        sharp(bytes).rotate().resize(384, 384, { fit: "inside", withoutEnlargement: true }).webp({ quality: 60 }).toBuffer(),
        captureDetails(bytes),
      ]);
    return {
      id: upload.id,
      capturedAt: details.capturedAt ?? null,
      place: coarsePlace(details.gps, privacy),
      image: thumbnail.toString("base64"),
      mimeType: "image/webp",
    };
  }

  private async buildCuratedDraft(
    story: Story,
    uploads: StoryUpload[],
    byId: Map<string, StoryUpload>,
    curation: Curation,
    admissionKey: string
  ) {
    const now = this.now(),
      runId = randomUUID();
    let processing: Story;
    try {
      processing = await this.repository.saveStory(
        { ...story, title: curation.title, status: "processing", activeRunId: runId, processorRevision, updatedAt: now },
        story.version
      );
    } catch (error) {
      throw publicationError(error);
    }
    const run: StoryRun = {
        id: runId,
        storyId: story.id,
        processorRevision,
        admissionKey,
        admittedAt: now,
        status: "processing",
        stage: "curating",
        progress: 0,
        attempts: 1,
        sourceUploadIds: uploads.map(upload => upload.id),
        startedAt: now,
        updatedAt: now,
      },
      written: string[] = [];
    try {
      await this.repository.createRun(run);
      const limit = pLimit(3),
        assets = await Promise.all(
          curation.photos.map(photo => limit(() => this.curatedAsset(processing, runId, byId.get(photo.id)!, written)))
        ),
        manifest = curatedManifest(processing, curation, assets, undefined, this.now());
      await this.hostedValidator(story.id, runId, manifest, story.locationPrivacy);
      await this.repository.completeRun(processing, run, manifest, this.now());
    } catch (error) {
      return this.failCuration(processing, run, written, error);
    }
    try {
      await this.removeSources(uploads);
    } catch (error) {
      throw new StoryServiceError(
        "INVALID_STATE",
        `The draft is saved, but its original photos could not be removed yet (${errorText(error)}). They are removed when the story's ` +
          "sources expire."
      );
    }
    return this.storyById(story.id);
  }

  /** A new curation over a draft: only the draft's stored photos can be chosen, and their derivatives are reused. */
  private async recurate(story: Story, base: TripManifest, curation: Curation) {
    const stored = new Map(base.photos.map(photo => [photo.id, photo])),
      unknown = curation.photos.filter(photo => !stored.has(photo.id)).map(photo => photo.id);
    if (unknown.length) throw new StoryServiceError("VALIDATION_ERROR", `These photo IDs are not in this story: ${unknown.join(", ")}.`);
    const manifest = curatedManifest(
        story,
        curation,
        curation.photos.map(photo => stored.get(photo.id)!),
        base,
        this.now()
      ),
      errors = validateHostedManifestPolicy(manifest, story.locationPrivacy);
    if (errors.length) throw new StoryServiceError("VALIDATION_ERROR", "The curated story does not satisfy its privacy policy.");
    try {
      return await this.repository.saveStory({ ...story, title: curation.title, manifest, updatedAt: this.now() }, story.version);
    } catch (error) {
      throw publicationError(error);
    }
  }

  /** Reads one original and writes its three WebP derivatives (no metadata) under the run, as the generation pipeline sizes them. */
  private async curatedAsset(story: Story, runId: string, upload: StoryUpload, written: string[]): Promise<CuratedAsset> {
    const bytes = await this.objects.read(upload.blobPath),
      details = await captureDetails(bytes),
      source = sharp(bytes).rotate(),
      paths: Record<(typeof derivativeSizes)[number]["variant"], string> = { large: "", medium: "", thumb: "" };
    let large: Buffer | undefined;
    for (const { variant, size, quality } of derivativeSizes) {
      const image = await source.clone().resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality }).toBuffer(),
        name = `${upload.id}-${variant}.webp`,
        pathname = `derivatives/${story.id}/${story.processorRevision}/${runId}/${name}`;
      written.push(pathname);
      await this.objects.write(pathname, image, "image/webp");
      paths[variant] = `/api/media/${story.id}/${encodeURIComponent(`${story.processorRevision}--${runId}--${name}`)}`;
      if (variant === "large") large = image;
    }
    const metadata = await sharp(large).metadata(),
      blur = await source.clone().resize(24, 24, { fit: "inside" }).webp({ quality: 35 }).toBuffer();
    if (!metadata.width || !metadata.height) throw new Error(`Photo ${upload.id} has no readable size.`);
    return {
      id: upload.id,
      srcLarge: paths.large,
      srcMedium: paths.medium,
      srcThumb: paths.thumb,
      width: metadata.width,
      height: metadata.height,
      blurDataURL: `data:image/webp;base64,${blur.toString("base64")}`,
      captureTime: details.capturedAt,
    };
  }

  /** Records a curation that could not finish: the run and the story fail, its new derivatives go, and the originals stay for a retry. */
  private async failCuration(processing: Story, run: StoryRun, written: string[], error: unknown): Promise<never> {
    const now = this.now();
    let cleanupError: unknown;
    try {
      if (written.length) await this.objects.remove(written);
    } catch (failure) {
      cleanupError = failure;
    }
    if (await this.repository.findRun(run.id)) {
      await this.repository.saveRun({
        ...run,
        status: "failed",
        stage: "failed",
        errorCode: "CURATION_FAILED",
        errorMessage: "Wanderpage could not build this draft. Your original photos remain private.",
        finishedAt: now,
        updatedAt: now,
      });
      // A failed run whose derivatives are not marked deleted is retried by the daily derivative cleanup.
      if (!cleanupError) await this.repository.markRunDerivativesDeleted(run.id, now);
    }
    await this.repository.saveStory({ ...processing, status: "failed", activeRunId: undefined, updatedAt: now }, processing.version);
    if (cleanupError) throw new AggregateError([error, cleanupError], "Curation and derivative cleanup both failed.");
    if (error instanceof StoryServiceError) throw error;
    throw new StoryServiceError(
      "INVALID_STATE",
      `Wanderpage could not build the draft (${errorText(error)}). The story is now failed and keeps its photos: call save_curation again.`
    );
  }

  /** Removes a finished curation's originals, as generation does once its draft is complete. */
  private async removeSources(uploads: StoryUpload[]) {
    await this.objects.remove(uploads.map(upload => upload.blobPath));
    const now = this.now();
    await Promise.all(
      uploads.map(upload => this.repository.saveUpload({ ...upload, status: "deleted", cleanupClaimedAt: undefined, deletedAt: now }))
    );
  }

  private async storyById(storyId: string) {
    const story = await this.repository.findStory(storyId);
    if (!story) throw new StoryServiceError("NOT_FOUND", "Story not found.");
    return story;
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

/** Private object storage: the story's original uploads and its WebP derivatives. Production uses Vercel Blob. */
export type StoryObjects = {
  read(pathname: string): Promise<Buffer>;
  write(pathname: string, bytes: Buffer, contentType: "image/webp"): Promise<void>;
  remove(pathnames: string[]): Promise<void>;
};

const blobObjects: StoryObjects = {
  read: async pathname => {
    const object = await get(pathname, { access: "private", useCache: false });
    if (!object || object.statusCode !== 200) throw new Error(`Private object ${pathname} is unavailable.`);
    return Buffer.from(await new Response(object.stream as never).arrayBuffer());
  },
  write: async (pathname, bytes, contentType) => {
    await put(pathname, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
  },
  remove: async pathnames => {
    if (pathnames.length) await del(pathnames);
  },
};

/** Photos per get_photos page, and the base64 image characters per page: the rest of the 1 MB tool result is text. */
export const photoPageSize = 12;
export const photoPageBudget = 900_000;

/** A place no finer than the story allows: about 11 km (city level) for approximate, about 110 km (region) for broad, none for hidden. */
export type ReviewPlace = { lat: number; lon: number; precision: string };
export type ReviewPhoto = { id: string; capturedAt: string | null; place: ReviewPlace | null; image: string; mimeType: "image/webp" };
export type PhotoPage = { storyId: string; total: number; photos: ReviewPhoto[]; nextCursor: string | null };

const curationText = (max: number) => z.string().trim().min(1).max(max);
const curationSchema = z.object({
  version: z.number().int().nonnegative().optional(),
  title: curationText(120),
  intro: curationText(1200),
  closing: curationText(600).optional(),
  photos: z
    .array(z.object({ id: z.string().min(1).max(100), caption: curationText(280) }))
    .min(1)
    .max(60),
});
export type CurationInput = z.input<typeof curationSchema>;
type Curation = z.output<typeof curationSchema>;

type CuratedAsset = Pick<
  TripManifest["photos"][number],
  "id" | "srcLarge" | "srcMedium" | "srcThumb" | "width" | "height" | "blurDataURL" | "captureTime" | "destinationId"
> &
  Partial<Pick<TripManifest["photos"][number], "containsPeople">>;

const derivativeSizes = [
  { variant: "large", size: 1800, quality: 80 },
  { variant: "medium", size: 900, quality: 78 },
  { variant: "thumb", size: 420, quality: 76 },
] as const;

/** The capture time (camera wall clock, no time zone) and GPS in a photo's EXIF; a photo without readable EXIF has neither. */
async function captureDetails(bytes: Buffer) {
  // exifr throws on formats it does not parse (some PNG and WebP files): such a photo has no capture time or GPS, as in ingest.
  const exif = (await exifr.parse(bytes, { gps: true, tiff: true, exif: true }).catch(() => undefined)) as
      Record<string, unknown> | undefined,
    taken = exif?.DateTimeOriginal,
    lat = exif?.latitude,
    lon = exif?.longitude;
  return {
    capturedAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? wallClock(taken) : undefined,
    gps: typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined,
  };
}

/** exifr reads EXIF times, which carry no zone, as local time; the local fields give back what the camera wrote. */
function wallClock(value: Date) {
  const two = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}:${two(value.getSeconds())}`;
}

function coarsePlace(gps: { lat: number; lon: number } | undefined, privacy: Story["locationPrivacy"]): ReviewPlace | null {
  if (!gps || privacy === "hidden") return null;
  const digits = privacy === "approximate" ? 1 : 0,
    round = (value: number) => Number(value.toFixed(digits)) || 0;
  return {
    lat: round(gps.lat),
    lon: round(gps.lon),
    precision: privacy === "approximate" ? "city level, about 11 km" : "region level, about 110 km",
  };
}

const honorific = /\b(?:mr|mrs|ms|mx|miss|dr|prof|sir|dame|uncle|aunt|auntie|grandma|grandpa|granny|nana)\.?\s+(\p{L}+)/giu;
const relationship =
  /\b(?:my|our|his|her|their|your)\s+(?:(?:little|big|best|older|younger|dear|lovely)\s+)?(?:wife|husband|partner|spouse|son|sons|daughter|daughters|kid|kids|child|children|mom|mum|mother|dad|father|parents?|brother|sister|siblings?|friend|friends|boyfriend|girlfriend|fianc[eé]e?|grandma|grandmother|grandpa|grandfather|grandparents?|uncle|aunt|cousin|niece|nephew|baby|family|colleague|boss)\b/iu;
/** Family names for a person that identify the relationship on their own: "Mom at the lookout", "Grandma's favourite café". */
const kinName = /\b(?:mom|mommy|mum|mummy|dad|daddy|grandma|grandpa|granny|grandad|granddad|nana|nonna|nonno|oma|opa)\b/iu;
const namedPerson =
  /\b(?:man|woman|boy|girl|person|guy|lady|kid|child|baby|friend|traveler|traveller|tourist|local)\s+(?:named|called)\s+\p{Lu}/iu;
const handle = /(?:^|[\s(])@[\p{L}\p{N}_.]{2,}/u;
const nameAndI = /\b\p{Lu}\p{Ll}+\s+and\s+(?:I|me)\b/u;
/**
 * Common given names. Names that are also common places, months or nature words in travel text (Paris, Florence, Sofia, June, River,
 * Rose) are left out, and a name inside a place's name (`placeBefore`, `placeAfter`) is a place, not a person.
 */
const givenNames = new Set(
  (
    "aaron adam adrian ahmed aiden alan albert alberto alejandro alex alexander alfie ali alice alicia amanda amelia amy ana andrea " +
    "andrew andy angela anna anne annie anthony antonio arthur ava barbara ben benjamin beth betty bob brian bruce carl carla carlos " +
    "carmen caroline catherine charlie chloe chris christian christina christine christopher claire clara daniel david deborah dennis " +
    "diana diego dmitri donald dorothy edward elena eli elizabeth ellie emily emma eric erik ethan eva evelyn fatima " +
    "felix fernando francesca frank fred gabriel george giulia giuseppe greg hannah harry heather helen henry hiroshi hugo " +
    "ian isaac isabel isabella jack jacob james jamie jane janet jason javier jean jennifer jeremy jessica jim jimmy joan joe joel " +
    "johan john jonathan jorge jose joseph josh joshua juan julia julian julie karen kate katie keith kenji kevin kim laura lauren " +
    "leo liam linda lisa lucas lucia lucy luis luka luke maria mariana marie mario martin mary matteo matthew max maya megan " +
    "mia michael michelle miguel mike mohammed muhammad nancy natalie nathan nick nicole noah oliver olivia omar oscar pablo patrick " +
    "paul pedro peter rachel rebecca richard rob robert roberto ryan sam samantha samuel sara sarah scott sean sebastian simon " +
    "sophia sophie stephen steve steven susan takeshi thomas tim timothy tom tony tyler victor william yuki zoe"
  ).split(" ")
);
/** A word before a name that makes it part of a place's name: "Santa Maria", "Lake George", "Playa del Carmen", "Saint-Martin". */
const placeBefore =
  /(?:^|[\s(])(?:st|saint|san|santa|santo|são|sao|sainte|sankt|ste|lake|port|fort|mount|mt|cape|point|glen|prince|princess|king|queen|piazza|plaza|via|rue|calle|del|de|di|da|do|dos|das|des|du|la|le)\.?[\s-]*$/iu;
/** A word after a name that makes it part of a place's name: "John Street", "Albert Dock", "Alice Springs", "Arthur's Seat". */
const placeAfter =
  /^\s*(?:'s\s+)?(?:street|st\b|road|rd\b|avenue|ave\b|lane|way|place|plaza|quarter|church|cathedral|chapel|basilica|bridge|bay|island|islands|lake|park|square|hall|tower|gate|market|mountain|mount|river|beach|point|falls|springs|castle|palace|museum|station|harbor|harbour|dock|docks|valley|peak|hill|seat|gardens?|lighthouse|hotel|inn|cafe|café|restaurant|bar|pier|quay|wharf)\b/iu;

/** The first common given name in `text` that reads as a person, not as part of a place's name. */
function givenName(text: string) {
  for (const found of text.matchAll(/\p{Lu}\p{Ll}+/gu)) {
    const word = found[0],
      start = found.index ?? 0;
    if (!givenNames.has(word.toLowerCase())) continue;
    if (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1] ?? "")) continue;
    const after = text.slice(start + word.length);
    if (/^[\p{L}\p{N}]/u.test(after)) continue;
    if (placeBefore.test(text.slice(0, start)) || placeAfter.test(after)) continue;
    return word;
  }
  return undefined;
}

/**
 * The first title, intro or caption that names or identifies a person: a common given name ("Maria on the bridge"), an honorific
 * with a name ("Mr. Tanaka"), a relationship ("my wife", "Mom"), "a woman named …", a social handle, or "<Name> and I". A pattern
 * check, so it backs up the skill's privacy rule rather than replacing it.
 */
function identifyingText(curation: Curation) {
  const fields: Array<{ field: string; text: string }> = [
    { field: "title", text: curation.title },
    { field: "intro", text: curation.intro },
    ...(curation.closing ? [{ field: "closing", text: curation.closing }] : []),
    ...curation.photos.map(photo => ({ field: `caption for photo ${photo.id}`, text: photo.caption })),
  ];
  for (const { field, text } of fields) {
    for (const found of text.matchAll(honorific)) if (/^\p{Lu}/u.test(found[1] ?? "")) return { field, match: found[0] };
    const match = relationship.exec(text) ?? kinName.exec(text) ?? namedPerson.exec(text) ?? handle.exec(text) ?? nameAndI.exec(text);
    if (match) return { field, match: match[0].trim() };
    const name = givenName(text);
    if (name) return { field, match: name };
  }
  return undefined;
}

/**
 * The draft page for a curation: the photos in the chosen order with their captions (also their alt text), chapters for each run of
 * photos from one day or one destination, the title and the intro. Over a draft (`base`) it keeps the draft's destinations and route.
 */
function curatedManifest(story: Story, curation: Curation, assets: CuratedAsset[], base: TripManifest | undefined, now: Date) {
  const captions = new Map(curation.photos.map(photo => [photo.id, photo.caption])),
    destinations = base?.destinations ?? [],
    captures = assets
      .map(asset => asset.captureTime)
      .filter((value): value is string => Boolean(value))
      .sort(),
    chapters: TripManifest["chapters"] = [];
  let lastKey: string | undefined;
  for (const asset of assets) {
    const key = asset.destinationId ?? asset.captureTime?.slice(0, 10) ?? "story",
      chapter = chapters.at(-1);
    if (chapter && key === lastKey) {
      chapter.photoIds.push(asset.id);
      continue;
    }
    lastKey = key;
    const index = chapters.length,
      destination = destinations.find(item => item.id === asset.destinationId),
      date = asset.captureTime?.slice(0, 10);
    chapters.push({
      id: `chapter-${index + 1}`,
      title: destination?.name ?? (date ? `Day of ${date}` : `Chapter ${index + 1}`),
      destinationId: destination?.id,
      date,
      narrative: "A sequence ordered from the available photographic evidence.",
      photoIds: [asset.id],
      layout: (["split", "editorial", "mosaic", "filmstrip"] as const)[index % 4]!,
    });
  }
  return TripManifestSchema.parse({
    schemaVersion: "1.0",
    generatedAt: now.toISOString(),
    published: false,
    title: curation.title,
    subtitle: base?.subtitle ?? "A photographic story.",
    opening: curation.intro,
    closing: curation.closing ?? base?.closing ?? "The last frame closes the story.",
    dateRange: captures.length ? { start: captures[0]!.slice(0, 10), end: captures.at(-1)!.slice(0, 10) } : undefined,
    peopleMode: story.peopleMode,
    theme: base?.theme ?? { background: "#f2eee5", foreground: "#17211f", accent: "#c76542", muted: "#a4aca5" },
    heroPhotoId: assets[0]!.id,
    stats: [
      { label: "Days", value: String(new Set(captures.map(value => value.slice(0, 10))).size || 1) },
      { label: "Selected frames", value: String(assets.length) },
    ],
    destinations,
    route: base?.route ?? [],
    chapters,
    photos: assets.map(asset => ({
      ...asset,
      alt: captions.get(asset.id)!,
      caption: captions.get(asset.id)!,
      // A new curation has no people analysis; the skill leaves photos with people out of an `exclude` story.
      containsPeople: asset.containsPeople ?? false,
      source: "user",
    })),
    sources: base?.sources ?? [],
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

void StoryStatuses;
