// @design DES-WEB-STORY
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { get, put } from "@vercel/blob";
import exifr from "exifr";
import pLimit from "p-limit";
import sharp from "sharp";
import { z } from "zod";
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
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";
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

/**
 * The processor revision of a page the owner's own Claude curated (BUI-2205): `save_curation` builds it with no AI call, so its runs
 * never count toward the paid generation limits (`StoryRepository.queueRun` leaves them out).
 */
export const curationRevision = "claude-v1";

/**
 * Where curation reads the original uploads and writes the page's derivatives (BUI-2205). Production uses private Vercel Blob objects,
 * the same objects the upload route writes and the media route and publish validator read.
 */
export type CurationMedia = {
  read(upload: Pick<StoryUpload, "id" | "blobPath">): Promise<Buffer>;
  write(pathname: string, bytes: Buffer): Promise<void>;
};

/** One photo `get_photos` returns: a small WebP preview, never the original, and never a place finer than the story allows. */
export type CurationPreview = {
  photoId: string;
  thumbnail: Buffer;
  captureDate: string | null;
  place: { lat: number; lon: number; precision: string } | null;
};

/** What Claude sends to `save_curation`: the chosen photos in page order, a caption each, and the page text. */
export type CurationInput = {
  title: string;
  intro: string;
  closing?: string;
  photos: Array<{ photoId: string; caption: string; containsPeople?: boolean }>;
};

/** A `get_photos` page stays under the 1 MB claude.ai reports for one tool result: base64 images plus the JSON text. */
export const curationPageBudget = 900_000;
/**
 * How long a curation build may go without progress before it counts as interrupted (BUI-2205). `save_curation` builds the page inside
 * one MCP request and records progress after each photo; a request killed mid-build (a function timeout, a deploy) leaves the story
 * `processing`, and after this lease the next `get_photos` may read it and the next `save_curation` fails the dead run and starts again.
 */
export const curationLeaseMs = 5 * 60 * 1000;
const curationPageSize = 10,
  previewEdge = 320,
  previewOverhead = 400;

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
    private readonly media: CurationMedia = blobCurationMedia
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
   * One page of a story's uploaded photos for the owner's Claude to review (BUI-2205): small WebP previews with no metadata, each with its
   * capture date and a place no finer than the story's location privacy, and the cursor of the next page. A page holds at most
   * `curationPageSize` photos and stays within `curationPageBudget` bytes once the previews are base64.
   */
  async listCurationPhotos(rawSecret: string, storyId: string, cursor = 0) {
    const { story } = await this.curatableStory(rawSecret, storyId),
      uploads = await this.curationUploads(story.id);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > uploads.length)
      throw new StoryServiceError("VALIDATION_ERROR", `The cursor must be a page cursor from get_photos, from 0 to ${uploads.length}.`);
    const candidates = uploads.slice(cursor, cursor + curationPageSize),
      limit = pLimit(4),
      previews = await Promise.all(
        candidates.map(upload => limit(async () => preview(upload.id, await this.media.read(upload), story.locationPrivacy)))
      ),
      page: CurationPreview[] = [];
    let bytes = 0;
    for (const item of previews) {
      const size = Math.ceil(item.thumbnail.length / 3) * 4 + previewOverhead;
      if (bytes + size > curationPageBudget) break;
      page.push(item);
      bytes += size;
    }
    if (!page.length && candidates.length) throw new Error("A photo preview is larger than one get_photos page.");
    const next = cursor + page.length;
    return { story, photos: page, total: uploads.length, nextCursor: next < uploads.length ? next : null };
  }

  /**
   * Saves the owner's Claude's curation as the story's private draft (BUI-2205): the chosen photos in order with Claude's captions,
   * title and intro. The server only resizes the chosen originals into the page's WebP copies (no metadata) and builds the manifest; no
   * AI call is made, and the run's `curationRevision` keeps it out of the paid generation limits. Unknown photo IDs, text that names or
   * identifies a person, and, in a story that excludes people, a photo Claude did not mark `containsPeople: false`, are refused.
   */
  async saveCuration(rawSecret: string, storyId: string, input: CurationInput, admissionKey: string) {
    const curatable = await this.curatableStory(rawSecret, storyId),
      session = curatable.session,
      story = curatable.interrupted ? await this.failInterruptedCuration(curatable.story, curatable.interrupted) : curatable.story,
      uploads = await this.curationUploads(story.id),
      chosen = checkedCuration(story, input, uploads);
    if (!admits(this.generationPolicy(), session))
      throw new StoryServiceError("INVALID_STATE", "Story creation is temporarily unavailable.");
    const now = this.now(),
      runId = randomUUID(),
      unbounded = Number.MAX_SAFE_INTEGER;
    let queued: Story;
    try {
      queued = await this.repository.queueRun(
        { ...story, updatedAt: now, processorRevision: curationRevision },
        curationRun(runId, story.id, admissionKey, now),
        { sessionStarts: unbounded, clientStarts: unbounded, globalStarts: unbounded, since: now, now, minPhotos: 1 }
      );
    } catch (error) {
      if (error instanceof Error && error.message === "STORY_VERSION_CONFLICT")
        throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed while the curation was saved. Read it and try again.");
      if (error instanceof Error && error.message === "SOURCE_NOT_READY")
        throw new StoryServiceError("INVALID_STATE", "The source photos are incomplete or expired. Start a new private story.");
      throw error;
    }
    try {
      const claimed = await this.repository.claimRun(queued.id, runId, this.now()),
        manifest = await this.curatedManifest(claimed.story, runId, input, chosen),
        errors = validateHostedManifestPolicy(manifest, story.locationPrivacy);
      if (errors.length) throw new StoryServiceError("VALIDATION_ERROR", "The curated page does not satisfy the story's privacy policy.");
      await this.repository.completeRun(claimed.story, claimed.run, manifest, this.now());
      const draft = await this.repository.findStory(story.id);
      if (!draft) throw new Error("The curated story disappeared while its draft was saved.");
      if (draft.title === input.title.trim()) return draft;
      return await this.repository.saveStory({ ...draft, title: input.title.trim(), updatedAt: this.now() }, draft.version);
    } catch (error) {
      const run = await this.repository.findRun(runId),
        current = await this.repository.findStory(story.id);
      if (run && run.status !== "complete")
        await this.repository.saveRun({
          ...run,
          status: "failed",
          stage: "curation",
          errorCode: "CURATION_FAILED",
          errorMessage: "Wanderpage could not build the curated page. Please try again.",
          finishedAt: this.now(),
          updatedAt: this.now(),
        });
      if (current && current.activeRunId === runId)
        await this.repository.saveStory({ ...current, status: "failed", activeRunId: undefined, updatedAt: this.now() }, current.version);
      throw error;
    }
  }

  /**
   * The owner's story while its originals are still stored: uploading, failed, or held by a curation build that made no progress for
   * `curationLeaseMs` (`interrupted` names that run). A curation build still within its lease, and a generation run, are refused.
   */
  private async curatableStory(rawSecret: string, storyId: string) {
    const owned = await this.getOwnedStoryWithSession(rawSecret, storyId),
      { story } = owned;
    let interrupted: StoryRun | undefined;
    if ((story.status === "queued" || story.status === "processing") && story.activeRunId) {
      const run = await this.repository.findRun(story.activeRunId);
      if (run?.processorRevision === curationRevision) {
        const resumesAt = run.updatedAt.getTime() + curationLeaseMs;
        if (resumesAt > this.now().getTime())
          throw new StoryServiceError(
            "INVALID_STATE",
            `This story's curated page is still being built. If save_curation was interrupted, call it again after ` +
              `${new Date(resumesAt).toISOString()}.`
          );
        interrupted = run;
      }
    }
    if (!interrupted && story.status !== "uploading" && story.status !== "failed")
      throw new StoryServiceError(
        "INVALID_STATE",
        `This story is ${story.status}: its photos can be reviewed and curated only while it is uploading or failed.`
      );
    if (story.sourceExpiresAt <= this.now())
      throw new StoryServiceError("INVALID_STATE", "These source photos have expired. Start a new private story.");
    return { ...owned, interrupted };
  }

  /** Ends a curation build whose request died: the run fails, the story is failed again, and its sources stay for the next build. */
  private async failInterruptedCuration(story: Story, run: StoryRun) {
    const now = this.now();
    await this.repository.saveRun({
      ...run,
      status: "failed",
      stage: "curation",
      errorCode: "CURATION_INTERRUPTED",
      errorMessage: "The curated page build stopped before it finished.",
      finishedAt: now,
      updatedAt: now,
    });
    try {
      return await this.repository.saveStory({ ...story, status: "failed", activeRunId: undefined, updatedAt: now }, story.version);
    } catch (error) {
      if (error instanceof Error && error.message === "STORY_VERSION_CONFLICT")
        throw new StoryServiceError("STORY_VERSION_CONFLICT", "This story changed while the curation was saved. Read it and try again.");
      throw error;
    }
  }

  /** The confirmed uploads in upload order, the order `get_photos` pages through. */
  private async curationUploads(storyId: string) {
    return (await this.repository.listUploads(storyId))
      .filter(upload => upload.status === "confirmed")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  private async curatedManifest(story: Story, runId: string, input: CurationInput, chosen: CuratedPhoto[]): Promise<TripManifest> {
    let done = 0;
    const limit = pLimit(3),
      written = await Promise.all(
        chosen.map((photo, index) =>
          limit(async () => {
            const base = `photo-${String(index + 1).padStart(2, "0")}`,
              derivatives = await derivativesOf(await this.media.read(photo.upload)),
              paths = {} as Record<"large" | "medium" | "thumb", string>;
            for (const size of ["large", "medium", "thumb"] as const) {
              const name = `${base}-${size}.webp`;
              await this.media.write(`derivatives/${story.id}/${curationRevision}/${runId}/${name}`, derivatives[size]);
              paths[size] = `/api/media/${story.id}/${encodeURIComponent(`${curationRevision}--${runId}--${name}`)}`;
            }
            // Each finished photo renews the build's lease, so only a build that stopped is ever taken as interrupted.
            done += 1;
            await this.repository.markRunProgress(
              story.id,
              runId,
              "curation",
              Math.min(95, 5 + Math.round((done / chosen.length) * 90)),
              this.now()
            );
            return { ...photo, ...derivatives, paths };
          })
        )
      ),
      captures = written.map(photo => photo.captureTime).filter((value): value is string => Boolean(value)),
      sorted = [...captures].sort(),
      chapters: TripManifest["chapters"] = [];
    for (const photo of written) {
      const date = photo.captureTime?.slice(0, 10),
        last = chapters.at(-1);
      if (last && last.date === date) last.photoIds.push(photo.upload.id);
      else
        chapters.push({
          id: `chapter-${chapters.length + 1}`,
          title: date ? `Day of ${date}` : `Chapter ${chapters.length + 1}`,
          date,
          narrative: "",
          photoIds: [photo.upload.id],
          layout: (["split", "editorial", "mosaic", "filmstrip"] as const)[chapters.length % 4]!,
        });
    }
    return TripManifestSchema.parse({
      schemaVersion: "1.0",
      generatedAt: this.now().toISOString(),
      published: false,
      title: input.title.trim(),
      subtitle: "",
      opening: input.intro.trim(),
      closing: input.closing?.trim() ?? "",
      dateRange: sorted.length ? { start: sorted[0]!.slice(0, 10), end: sorted.at(-1)!.slice(0, 10) } : undefined,
      peopleMode: story.peopleMode,
      theme: { background: "#f2eee5", foreground: "#17211f", accent: "#c76542", muted: "#a4aca5" },
      heroPhotoId: written[0]!.upload.id,
      stats: [
        { label: "Days", value: String(new Set(captures.map(value => value.slice(0, 10))).size || 1) },
        { label: "Selected frames", value: String(written.length) },
      ],
      destinations: [],
      route: [],
      chapters,
      photos: written.map(photo => ({
        id: photo.upload.id,
        srcLarge: photo.paths.large,
        srcMedium: photo.paths.medium,
        srcThumb: photo.paths.thumb,
        width: photo.width,
        height: photo.height,
        blurDataURL: photo.blurDataURL,
        alt: photo.caption,
        caption: photo.caption,
        captureTime: photo.captureTime,
        containsPeople: photo.containsPeople,
        source: "user",
      })),
      sources: [],
    });
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

type CuratedPhoto = { upload: StoryUpload; caption: string; containsPeople: boolean };

/**
 * Checks Claude's curation against the story before anything is stored: every photo ID is one of the story's confirmed uploads, chosen
 * once; no text names or identifies a person; and in a story that excludes people every photo carries Claude's own `containsPeople:
 * false` (REQ-SEL-02, SN-02: fail, do not guess). In a story that includes people an unsent value is stored as `true` (may show a person),
 * never as `false`.
 */
function checkedCuration(story: Story, input: CurationInput, uploads: StoryUpload[]): CuratedPhoto[] {
  if (!input.photos.length) throw new StoryServiceError("VALIDATION_ERROR", "Choose at least one photo for the page.");
  const byId = new Map(uploads.map(upload => [upload.id, upload])),
    ids = input.photos.map(photo => photo.photoId),
    unknown = ids.filter(id => !byId.has(id)),
    repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (unknown.length)
    throw new StoryServiceError("VALIDATION_ERROR", `These photo IDs are not photos of this story: ${[...new Set(unknown)].join(", ")}.`);
  if (repeated.length)
    throw new StoryServiceError("VALIDATION_ERROR", `Choose each photo once; repeated: ${[...new Set(repeated)].join(", ")}.`);
  const texts = [
    ["title", input.title],
    ["intro", input.intro],
    ["closing", input.closing ?? ""],
    ...input.photos.map(photo => [`caption of ${photo.photoId}`, photo.caption] as const),
  ] as const;
  for (const [field, text] of texts) {
    const problem = personTextProblem(text);
    if (problem)
      throw new StoryServiceError(
        "VALIDATION_ERROR",
        `The ${field} names or identifies a person (${problem}). Describe scenes and places, never who someone is.`
      );
  }
  if (story.peopleMode === "exclude") {
    const unmarked = input.photos.filter(photo => typeof photo.containsPeople !== "boolean").map(photo => photo.photoId),
      withPeople = input.photos.filter(photo => photo.containsPeople === true).map(photo => photo.photoId);
    if (unmarked.length)
      throw new StoryServiceError(
        "VALIDATION_ERROR",
        `This story excludes people: set containsPeople for every chosen photo. Missing for: ${unmarked.join(", ")}.`
      );
    if (withPeople.length)
      throw new StoryServiceError(
        "VALIDATION_ERROR",
        `This story excludes people: leave out the photos that show a person: ${withPeople.join(", ")}.`
      );
  }
  return input.photos.map(photo => ({
    upload: byId.get(photo.photoId)!,
    caption: photo.caption.trim(),
    containsPeople: typeof photo.containsPeople === "boolean" ? photo.containsPeople : true,
  }));
}

const relation =
    /\b(?:my|our|his|her|their|your)\s+(?:\p{L}+\s+)?(?:wife|husband|partner|spouse|boyfriend|girlfriend|fianc[ée]e?|mom|mum|mother|dad|father|parents?|son|daughter|kids?|children|child|baby|brother|sister|siblings?|grand(?:ma|pa|mother|father|son|daughter|parents?|kids?|children)|aunt|uncle|cousin|niece|nephew|friends?|family|colleagues?|boss|neighbou?rs?)\b/iu,
  handle = /(?:^|[\s(])@[\p{L}\d_.]{2,}/u;

/**
 * Common given names in the languages travellers write captions in. Names that are mostly places or plain words (Paris, Florence,
 * Victoria, Georgia, Rose, Grace) are left out, so the check does not refuse ordinary scene text.
 */
const givenNames = new Set(
  (
    "aaron abby abigail adam adrian adriana agnes ahmed aiden aisha alan albert alberto alejandra alejandro aleksandr alessandro alex " +
    "alexander alexandra alexandre alfredo ali alice alicia alison amanda amelia amir amy ana anastasia andre andrea andreas andrei andres " +
    "andrew andy angela angelo anika anita ann anna anne annie anthony antoine antonio arjun arthur ashley astrid ava barbara beatriz " +
    "ben benjamin bernard beth betty bianca bill bob bobby brandon brian bruno bruce caitlin camila camille carl carla carlo carlos carmen " +
    "carol caroline carolina catarina catherine cecilia charles charlie chen chloe chris christina christine christopher " +
    "claire clara claudia colin connor craig cristina cristiano daniel daniela danielle david deborah denise dennis diana diego dmitri " +
    "dominic donald dorothy duarte edward elena eleanor elias elif eliza ella ellen ellie emily emma enrique eric erik erin esther ethan " +
    "eva evelyn fatima felipe felix fernanda fernando filipa filipe fiona francesca francesco francisco frank franz fred frederick " +
    "gabriel gabriela gary george gerald giovanni giulia gonçalo greg gregory gustavo hana hannah hans harry heather heidi helen helena " +
    "henry hiroshi hugo ian ibrahim ines inês ingrid isaac isabel isabella isabelle ivan jack jacob jacques jake james jamie jan jane " +
    "janet jason javier jean jeff jeffrey jennifer jeremy jessica jim jimmy joana joanna joao joão joe joel johann johanna john jonathan " +
    "jorge jose josé joseph josh joshua juan judith julia julian juliana julie julien justin karen karl kate katherine kathryn katie " +
    "keith kelly ken kenji kevin kim kyle larry laura lauren leo leonardo liam linda lisa liu lorenzo louis louise lucas lucia lucía " +
    "luis luís luisa luka luke lukas maja manuel marco marcos margaret maria mariana marie marina mario marta martha martin mary mateo " +
    "matilde matt matteo matthew max megan mehmet melissa mia michael michelle miguel mike mohammed muhammad nadia natalia natalie " +
    "nathan nicholas nick nicolas nicole nina noah nora oliver olivia omar oscar pablo patricia patrick paul paula pedro peter philip " +
    "pierre priya rachel rafael rahul raquel raul rebecca ricardo richard rita robert roberto rodrigo roger ronald ruth ryan sam samuel " +
    "sandra sara sarah scott sean sebastian sergio simon sophia sophie stefan stephanie stephen steve steven susan tanya " +
    "teresa thomas tiago tim timothy tom tomas tomás tony tyler valentina vanessa vasco vera veronica vicente vincent wei william yuki " +
    "yusuf zoe zoë"
  ).split(" ")
);
/** Titles that come before a person's name ("Mr. Silva", "Dona Rosa"); matched only when a capitalized name follows. */
const titles = new Set(
    (
      "mr mrs ms mx miss dr prof sir madam lady lord uncle aunt auntie grandma grandpa granny nana papa mama señor señora senhor senhora " +
      "monsieur madame dom dona don"
    ).split(" ")
  ),
  /** A given name right after these words is part of a place name ("São João", "Rua Augusta", "Praça Dom Pedro"). */
  placeBefore = new Set(
    (
      "são sao san santa santo st saint sainte lake port mount mt fort cape rua avenida via calle rue praça plaza piazza dom dona don " +
      "king queen prince princess"
    ).split(" ")
  ),
  /** A name phrase that ends in one of these nouns is a place, a building or a tribute ("Charles Bridge", "Vasco da Gama Bridge"). */
  placeNouns = new Set(
    (
      "street st road avenue square bridge station church chapel cathedral basilica palace castle tower gate park garden gardens market " +
      "museum hotel beach bay island harbour harbor hall theatre theater monument fountain hill falls river lake valley quay pier town " +
      "statue memorial tomb bust"
    ).split(" ")
  ),
  /** Lowercase words a place name may hold between its capitalized words ("Vasco da Gama", "Henry the Navigator"). */
  nameParticles = new Set("da de do dos das del della di du van von der den la le of the".split(" ")),
  /** "Monument to Henry", "statue of Maria", "named after Pedro", "Our Lady of Fatima": a dedication, not a person in the photo. */
  dedicationBefore = new Set([...placeNouns, "portrait", "house", "home", "named", "lady", "lord"]);

const isCapitalized = (word: string | undefined) => word !== undefined && /^\p{Lu}/u.test(word);

/** Whether the capitalized phrase from `start` (names, particles, numerals) ends in a place noun within five words. */
function endsInPlace(words: string[], start: number) {
  for (let index = start + 1; index < words.length && index <= start + 5; index += 1) {
    const word = words[index]!,
      lower = word.toLowerCase();
    if (placeNouns.has(lower)) return true;
    if (!nameParticles.has(lower) && !isCapitalized(word)) return false;
  }
  return false;
}

function isDedication(words: string[], index: number) {
  const link = words[index - 1]?.toLowerCase(),
    noun = words[index - 2]?.toLowerCase();
  return (link === "to" || link === "of" || link === "for" || link === "after") && noun !== undefined && dedicationBefore.has(noun);
}

/** The words of `text`, with a possessive "'s" or a closing "." removed ("Ana's" is "Ana", "Mr." is "Mr"). */
function wordsOf(text: string) {
  return [...text.matchAll(/[\p{L}][\p{L}'’.-]*/gu)].map(match => match[0].replace(/(?:['’]s|['’.])$/u, ""));
}

function titledName(words: string[]) {
  return words.some(
    (word, index) =>
      titles.has(word.toLowerCase()) &&
      !placeBefore.has(words[index - 1]?.toLowerCase() ?? "") &&
      !isDedication(words, index) &&
      isCapitalized(words[index + 1]) &&
      !placeNouns.has(words[index + 1]!.toLowerCase()) &&
      !endsInPlace(words, index)
  );
}

function namedPerson(words: string[]) {
  return words.find((word, index) => {
    if (!isCapitalized(word) || !givenNames.has(word.toLowerCase())) return false;
    const before = words[index - 1]?.toLowerCase();
    return !(before && placeBefore.has(before)) && !endsInPlace(words, index) && !isDedication(words, index);
  });
}

/**
 * Why `text` names or identifies a person, or `undefined`. A guard behind the skill's rule: it catches a title before a name
 * ("Mr. Silva"), a given name ("Maria by the river"), a relationship ("my wife", "our friends") and a social handle ("@ana"). A name
 * that is part of a place or a dedication ("Charles Bridge", "Our Lady of Fatima", "Monument to Henry the Navigator") is scene text.
 */
export function personTextProblem(text: string) {
  const words = wordsOf(text);
  if (titledName(words)) return "a title before a name";
  const name = namedPerson(words);
  if (name) return `the name "${name}"`;
  if (relation.test(text)) return "a personal relationship";
  if (handle.test(text)) return "a social media handle";
  return undefined;
}

function curationRun(id: string, storyId: string, admissionKey: string, now: Date): StoryRun {
  return {
    id,
    storyId,
    processorRevision: curationRevision,
    admissionKey,
    admittedAt: now,
    status: "queued",
    stage: "queued",
    progress: 0,
    attempts: 0,
    sourceUploadIds: [],
    updatedAt: now,
  };
}

type PhotoFacts = { captureTime?: string; gps?: { lat: number; lon: number } };

/** The capture time and GPS of an original. An original with no readable EXIF has neither. */
async function photoFacts(bytes: Buffer): Promise<PhotoFacts> {
  let exif: Record<string, unknown> | undefined;
  try {
    exif = (await exifr.parse(bytes, { gps: true, tiff: true, exif: true })) as Record<string, unknown> | undefined;
  } catch (error) {
    // exifr reads JPEG and PNG but throws "Unknown file format" on WebP, an allowed upload type: such a photo has no capture time or GPS.
    if (error instanceof Error && /Unknown file format/i.test(error.message)) return {};
    throw error;
  }
  const lat = exif?.latitude,
    lon = exif?.longitude,
    taken = exif?.DateTimeOriginal;
  return {
    captureTime: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken.toISOString() : undefined,
    gps: typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined,
  };
}

/** A place no finer than the story allows: about 11 km for `approximate`, about 110 km for `broad`, none for `hidden`. */
function curationPlace(gps: PhotoFacts["gps"], privacy: Story["locationPrivacy"]) {
  if (!gps || privacy === "hidden") return null;
  const digits = privacy === "approximate" ? 1 : 0,
    round = (value: number) => Number(value.toFixed(digits)) + 0;
  return { lat: round(gps.lat), lon: round(gps.lon), precision: privacy === "approximate" ? "about 11 km" : "about 110 km" };
}

/** The processor's limit (`lib/web/processor.ts`): an original over 80 megapixels, or one sharp cannot size, is refused before resizing. */
async function readableOriginal(bytes: Buffer) {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 80_000_000)
    throw new StoryServiceError("VALIDATION_ERROR", "An uploaded image is unreadable or exceeds the 80 megapixel limit.");
}

async function preview(photoId: string, bytes: Buffer, privacy: Story["locationPrivacy"]): Promise<CurationPreview> {
  await readableOriginal(bytes);
  const facts = await photoFacts(bytes),
    thumbnail = await sharp(bytes)
      .rotate()
      .resize(previewEdge, previewEdge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 60 })
      .toBuffer();
  return { photoId, thumbnail, captureDate: facts.captureTime?.slice(0, 10) ?? null, place: curationPlace(facts.gps, privacy) };
}

/** The page's three WebP copies of one original, as the local pipeline sizes them (`lib/publishing/images.ts`); sharp drops metadata. */
async function derivativesOf(bytes: Buffer) {
  await readableOriginal(bytes);
  // Decode the original once, into the largest copy's pixels; the smaller copies are resized from those pixels, not from the original.
  const { data, info } = await sharp(bytes)
      .rotate()
      .resize(1800, 1800, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true }),
    pixels = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }),
    sized = (edge: number, quality: number) =>
      pixels().resize(edge, edge, { fit: "inside", withoutEnlargement: true }).webp({ quality }).toBuffer(),
    [large, medium, thumb, blur, facts] = await Promise.all([
      pixels().webp({ quality: 80 }).toBuffer(),
      sized(900, 78),
      sized(420, 76),
      pixels().resize(24, 24, { fit: "inside" }).webp({ quality: 35 }).toBuffer(),
      photoFacts(bytes),
    ]),
    metadata = { width: info.width, height: info.height };
  if (!metadata.width || !metadata.height) throw new Error("A curated photo could not be resized.");
  return {
    large,
    medium,
    thumb,
    width: metadata.width,
    height: metadata.height,
    blurDataURL: `data:image/webp;base64,${blur.toString("base64")}`,
    captureTime: facts.captureTime,
  };
}

/** Private Vercel Blob: the originals the upload route stored, and derivatives where the media route and publish validator read them. */
const blobCurationMedia: CurationMedia = {
  async read(upload) {
    const object = await get(upload.blobPath, { access: "private", useCache: false });
    if (!object || object.statusCode !== 200) throw new Error(`Private upload ${upload.id} is unavailable.`);
    return Buffer.from(await new Response(object.stream as never).arrayBuffer());
  },
  async write(pathname, bytes) {
    await put(pathname, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/webp",
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
  },
};

void StoryStatuses;
