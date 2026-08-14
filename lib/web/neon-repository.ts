import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
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

type Row = Record<string, unknown>;

export class NeonStoryRepository implements StoryRepository {
  constructor(private readonly sql: NeonQueryFunction<false, false>) {}

  static fromEnvironment() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for web story storage.");
    return new NeonStoryRepository(neon(url));
  }

  async createSession(session: OwnerSession) {
    await this.sql`
      INSERT INTO owner_sessions (id, secret_hash, csrf_token, created_at, last_seen_at, expires_at, terms_version, upload_consent_version)
      VALUES (${session.id}, ${session.secretHash}, ${session.csrfToken}, ${session.createdAt}, ${session.lastSeenAt}, ${session.expiresAt}, ${session.termsVersion}, ${session.uploadConsentVersion})
    `;
  }

  async createSessionAndStoryAdmitted(session: OwnerSession, value: Story, limits: StoryCreationLimits) {
    const rows = await this.sql`
      WITH admission_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext('wanderpage-story-admission'))
      ), admitted AS MATERIALIZED (
        SELECT 1 FROM admission_lock
        WHERE (SELECT count(*) FROM stories WHERE admission_key = ${value.admissionKey ?? null} AND created_at >= ${limits.since}) < ${limits.clientStories}
      ), inserted_session AS (
        INSERT INTO owner_sessions (id, secret_hash, csrf_token, created_at, last_seen_at, expires_at, terms_version, upload_consent_version)
        SELECT ${session.id}, ${session.secretHash}, ${session.csrfToken}, ${session.createdAt}, ${session.lastSeenAt}, ${session.expiresAt}, ${session.termsVersion}, ${session.uploadConsentVersion}
        FROM admitted RETURNING id
      )
      INSERT INTO stories (id, owner_session_id, admission_key, status, title, people_mode, location_privacy, processor_revision, source_expires_at, created_at, updated_at, version)
      SELECT ${value.id}, inserted_session.id, ${value.admissionKey ?? null}, ${value.status}, ${value.title}, ${value.peopleMode}, ${value.locationPrivacy}, ${value.processorRevision}, ${value.sourceExpiresAt}, ${value.createdAt}, ${value.updatedAt}, ${value.version}
      FROM inserted_session RETURNING id
    `;
    if (!rows.length) throw new Error("CLIENT_STORY_LIMIT");
  }

  async findSessionBySecretHash(secretHash: string) {
    const [row] = await this.sql`SELECT * FROM owner_sessions WHERE secret_hash = ${secretHash} LIMIT 1`;
    return row ? session(row) : undefined;
  }

  async touchSession(id: string, lastSeenAt: Date, expiresAt: Date) {
    await this
      .sql`UPDATE owner_sessions SET last_seen_at = ${lastSeenAt}, expires_at = ${expiresAt} WHERE id = ${id} AND revoked_at IS NULL`;
  }

  async createStory(story: Story) {
    await this.sql`
      INSERT INTO stories (id, owner_session_id, admission_key, public_slug, status, title, people_mode, location_privacy, manifest, processor_revision, active_run_id, source_expires_at, published_at, created_at, updated_at, deleted_at, version)
      VALUES (${story.id}, ${story.ownerSessionId}, ${story.admissionKey ?? null}, ${story.publicSlug ?? null}, ${story.status}, ${story.title}, ${story.peopleMode}, ${story.locationPrivacy}, ${story.manifest ?? null}, ${story.processorRevision}, ${story.activeRunId ?? null}, ${story.sourceExpiresAt}, ${story.publishedAt ?? null}, ${story.createdAt}, ${story.updatedAt}, ${story.deletedAt ?? null}, ${story.version})
    `;
  }

  async createStoryAdmitted(value: Story, limits: StoryCreationLimits) {
    const rows = await this.sql`
      WITH admission_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext('wanderpage-story-admission'))
      ), admitted AS MATERIALIZED (
        SELECT 1 FROM admission_lock
        WHERE (SELECT count(*) FROM stories WHERE owner_session_id = ${value.ownerSessionId} AND created_at >= ${limits.since}) < ${limits.sessionStories}
          AND (SELECT count(*) FROM stories WHERE admission_key = ${value.admissionKey ?? null} AND created_at >= ${limits.since}) < ${limits.clientStories}
      )
      INSERT INTO stories (id, owner_session_id, admission_key, status, title, people_mode, location_privacy, processor_revision, source_expires_at, created_at, updated_at, version)
      SELECT ${value.id}, ${value.ownerSessionId}, ${value.admissionKey ?? null}, ${value.status}, ${value.title}, ${value.peopleMode}, ${value.locationPrivacy}, ${value.processorRevision}, ${value.sourceExpiresAt}, ${value.createdAt}, ${value.updatedAt}, ${value.version}
      FROM admitted RETURNING id
    `;
    if (rows.length) return;
    const [sessionCount] = await this.sql`
      SELECT count(*)::int AS count FROM stories WHERE owner_session_id = ${value.ownerSessionId} AND created_at >= ${limits.since}
    `;
    if (sessionCount && number(sessionCount, "count") >= limits.sessionStories) throw new Error("SESSION_STORY_LIMIT");
    throw new Error("CLIENT_STORY_LIMIT");
  }

  async findStory(id: string) {
    const [row] = await this.sql`SELECT * FROM stories WHERE id = ${id} LIMIT 1`;
    return row ? story(row) : undefined;
  }

  async findPublishedStoryBySlug(publicSlug: string) {
    const [row] = await this
      .sql`SELECT * FROM stories WHERE public_slug = ${publicSlug} AND status = 'published' AND deleted_at IS NULL LIMIT 1`;
    return row ? story(row) : undefined;
  }

  async listStories(ownerSessionId: string) {
    const rows = await this
      .sql`SELECT * FROM stories WHERE owner_session_id = ${ownerSessionId} AND deleted_at IS NULL ORDER BY updated_at DESC`;
    return rows.map(story);
  }

  async saveStory(value: Story, expectedVersion: number) {
    const rows = await this.sql`
      UPDATE stories
      SET public_slug = ${value.publicSlug ?? null}, status = ${value.status}, title = ${value.title}, people_mode = ${value.peopleMode},
          location_privacy = ${value.locationPrivacy}, manifest = ${value.manifest ?? null}, processor_revision = ${value.processorRevision},
          active_run_id = ${value.activeRunId ?? null}, source_expires_at = ${value.sourceExpiresAt}, published_at = ${value.publishedAt ?? null},
          updated_at = ${value.updatedAt}, deleted_at = ${value.deletedAt ?? null}, version = version + 1
      WHERE id = ${value.id} AND version = ${expectedVersion}
      RETURNING *
    `;
    const [row] = rows;
    if (!row) throw new Error("STORY_VERSION_CONFLICT");
    return story(row);
  }

  async queueRun(value: Story, run: StoryRun, limits: GenerationLimits) {
    const rows = await this.sql`
      WITH admission_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext('wanderpage-generation-admission'))
      ), target AS MATERIALIZED (
        SELECT s.* FROM stories s WHERE s.id = ${value.id} AND s.version = ${value.version} FOR UPDATE
      ), admitted AS MATERIALIZED (
        SELECT target.id FROM target CROSS JOIN admission_lock
        WHERE (SELECT count(*) FROM story_runs WHERE updated_at >= ${limits.since}) < ${limits.globalStarts}
          AND (SELECT count(*) FROM story_runs r JOIN stories owned ON owned.id = r.story_id
               WHERE owned.owner_session_id = target.owner_session_id AND r.updated_at >= ${limits.since}) < ${limits.sessionStarts}
          AND (SELECT count(*) FROM story_runs WHERE admission_key = ${run.admissionKey ?? null} AND updated_at >= ${limits.since}) < ${limits.clientStarts}
          AND target.source_expires_at > ${limits.now}
          AND (SELECT count(*) FROM story_uploads WHERE story_id = target.id AND status = 'confirmed') >= ${limits.minPhotos}
      ), inserted AS (
        INSERT INTO story_runs (id, story_id, processor_revision, admission_key, status, stage, progress, attempts, source_upload_ids, updated_at)
        SELECT ${run.id}, ${run.storyId}, ${run.processorRevision}, ${run.admissionKey ?? null}, ${run.status}, ${run.stage}, ${run.progress}, ${run.attempts},
          ARRAY(SELECT id FROM story_uploads WHERE story_id = ${run.storyId} AND status = 'confirmed' ORDER BY created_at), ${run.updatedAt}
        FROM admitted RETURNING id
      )
      UPDATE stories SET status = 'queued', active_run_id = ${run.id}, processor_revision = ${value.processorRevision},
        source_expires_at = ${value.sourceExpiresAt}, updated_at = ${value.updatedAt}, version = version + 1
      WHERE id = ${value.id} AND EXISTS (SELECT 1 FROM inserted)
      RETURNING *
    `;
    const [row] = rows;
    if (row) return story(row);
    const [current] = await this.sql`SELECT version, owner_session_id FROM stories WHERE id = ${value.id}`;
    if (!current || number(current, "version") !== value.version) throw new Error("STORY_VERSION_CONFLICT");
    const [globalCount] = await this.sql`SELECT count(*)::int AS count FROM story_runs WHERE updated_at >= ${limits.since}`;
    if (!globalCount) throw new Error("Generation admission query returned no result.");
    if (number(globalCount, "count") >= limits.globalStarts) throw new Error("GLOBAL_GENERATION_LIMIT");
    const [clientCount] = await this.sql`
      SELECT count(*)::int AS count FROM story_runs WHERE admission_key = ${run.admissionKey ?? null} AND updated_at >= ${limits.since}
    `;
    if (clientCount && number(clientCount, "count") >= limits.clientStarts) throw new Error("CLIENT_GENERATION_LIMIT");
    const [sources] = await this.sql`
      SELECT source_expires_at,
        (SELECT count(*)::int FROM story_uploads WHERE story_id = stories.id AND status = 'confirmed') AS confirmed
      FROM stories WHERE id = ${value.id}
    `;
    if (!sources || date(sources, "source_expires_at") <= limits.now || number(sources, "confirmed") < limits.minPhotos)
      throw new Error("SOURCE_NOT_READY");
    throw new Error("SESSION_GENERATION_LIMIT");
  }

  async createRun(run: StoryRun) {
    await this.sql`
      INSERT INTO story_runs (id, story_id, workflow_run_id, processor_revision, admission_key, status, stage, progress, attempts, error_code, error_message, started_at, finished_at, source_upload_ids, updated_at)
      VALUES (${run.id}, ${run.storyId}, ${run.workflowRunId ?? null}, ${run.processorRevision}, ${run.admissionKey ?? null}, ${run.status}, ${run.stage}, ${run.progress}, ${run.attempts}, ${run.errorCode ?? null}, ${run.errorMessage ?? null}, ${run.startedAt ?? null}, ${run.finishedAt ?? null}, ${run.sourceUploadIds}, ${run.updatedAt})
    `;
  }

  async findRun(id: string) {
    const [row] = await this.sql`SELECT * FROM story_runs WHERE id = ${id} LIMIT 1`;
    return row ? run(row) : undefined;
  }

  async saveRun(value: StoryRun) {
    await this.sql`
      UPDATE story_runs
      SET workflow_run_id = ${value.workflowRunId ?? null}, status = ${value.status}, stage = ${value.stage}, progress = ${value.progress},
          attempts = ${value.attempts}, error_code = ${value.errorCode ?? null}, error_message = ${value.errorMessage ?? null},
          started_at = ${value.startedAt ?? null}, finished_at = ${value.finishedAt ?? null}, updated_at = ${value.updatedAt}
      WHERE id = ${value.id}
    `;
  }

  async setWorkflowRunId(runId: string, workflowRunId: string, now: Date) {
    const rows = await this.sql`
      UPDATE story_runs SET workflow_run_id = ${workflowRunId}, updated_at = ${now}
      WHERE id = ${runId} AND workflow_run_id IS NULL RETURNING id
    `;
    if (!rows.length) {
      const [current] = await this.sql`SELECT workflow_run_id FROM story_runs WHERE id = ${runId}`;
      if (!current || optionalString(current, "workflow_run_id") !== workflowRunId) throw new Error("RUN_STATE_CONFLICT");
    }
  }

  async completeRun(value: Story, run: StoryRun, manifest: Story["manifest"], now: Date) {
    const rows = await this.sql`
      WITH target AS MATERIALIZED (
        SELECT s.id FROM stories s JOIN story_runs r ON r.id = ${run.id} AND r.story_id = s.id
        WHERE s.id = ${value.id} AND s.version = ${value.version} AND s.active_run_id = r.id
          AND s.status = 'processing' AND r.status = 'processing'
        FOR UPDATE OF s, r
      ), claimed_sources AS (
        UPDATE story_uploads SET status = 'rejected', cleanup_claimed_at = ${now}
        WHERE id = ANY(${run.sourceUploadIds}) AND story_id IN (SELECT id FROM target) AND status = 'confirmed'
        RETURNING id
      ), completed_story AS (
        UPDATE stories SET status = 'draft', manifest = ${manifest ?? null}, active_run_id = NULL,
          updated_at = ${now}, version = version + 1
        WHERE id IN (SELECT id FROM target) AND (SELECT count(*) FROM claimed_sources) = cardinality(${run.sourceUploadIds})
        RETURNING id
      )
      UPDATE story_runs SET status = 'complete', stage = 'complete', progress = 100, finished_at = ${now}, updated_at = ${now}
      WHERE id = ${run.id} AND story_id IN (SELECT id FROM completed_story) AND status = 'processing'
      RETURNING id
    `;
    if (!rows.length) throw new Error("RUN_STATE_CONFLICT");
  }

  async claimRun(storyId: string, runId: string, now: Date) {
    const rows = await this.sql`
      WITH target AS MATERIALIZED (
        SELECT s.id FROM stories s JOIN story_runs r ON r.id = ${runId} AND r.story_id = s.id
        WHERE s.id = ${storyId} AND s.active_run_id = r.id
          AND ((s.status = 'queued' AND r.status = 'queued') OR (s.status = 'processing' AND r.status = 'processing'))
        FOR UPDATE OF s, r
      ), claimed_story AS (
        UPDATE stories SET status = 'processing', updated_at = ${now}, version = version + CASE WHEN status = 'queued' THEN 1 ELSE 0 END
        WHERE id IN (SELECT id FROM target) RETURNING *
      ), claimed_run AS (
        UPDATE story_runs SET status = 'processing', stage = 'curating', progress = GREATEST(progress, 5),
          attempts = attempts + CASE WHEN status = 'queued' THEN 1 ELSE 0 END,
          started_at = coalesce(started_at, ${now}), updated_at = ${now}
        WHERE id = ${runId} AND story_id IN (SELECT id FROM target) RETURNING *
      )
      SELECT row_to_json(claimed_story) AS story, row_to_json(claimed_run) AS run FROM claimed_story CROSS JOIN claimed_run
    `;
    const [row] = rows;
    if (!row || !row.story || !row.run) throw new Error("RUN_STATE_CONFLICT");
    return { story: story(row.story as Row), run: run(row.run as Row) };
  }

  async beginDeleteStory(storyId: string, ownerSessionId: string, now: Date) {
    const rows = await this.sql`
      WITH target AS MATERIALIZED (
        SELECT id FROM stories WHERE id = ${storyId} AND owner_session_id = ${ownerSessionId} AND status <> 'deleted' FOR UPDATE
      ), cancelled AS (
        UPDATE story_runs SET status = 'cancelled', stage = 'cancelled', finished_at = ${now}, updated_at = ${now}
        WHERE story_id IN (SELECT id FROM target) AND status IN ('queued', 'processing') RETURNING id
      )
      UPDATE stories SET status = 'deleting', public_slug = NULL, active_run_id = NULL,
        delete_after = coalesce(delete_after, ${new Date(now.getTime() + 15 * 60 * 1000)}),
        updated_at = ${now}, version = version + 1
      WHERE id IN (SELECT id FROM target) RETURNING *
    `;
    const [row] = rows;
    if (!row) throw new Error("STORY_NOT_FOUND");
    return story(row);
  }

  async beginOperatorDeleteStory(storyId: string, now: Date) {
    const [target] = await this.sql`SELECT owner_session_id FROM stories WHERE id = ${storyId} AND status <> 'deleted'`;
    if (!target) throw new Error("STORY_NOT_FOUND");
    return this.beginDeleteStory(storyId, string(target, "owner_session_id"), now);
  }

  async finishDeleteStory(storyId: string, now: Date) {
    const rows = await this.sql`
      WITH finished AS (
        UPDATE stories SET status = 'deleted', manifest = NULL, deleted_at = ${now}, updated_at = ${now}, version = version + 1
        WHERE id = ${storyId} AND status = 'deleting' AND delete_after <= ${now} RETURNING id
      )
      UPDATE story_uploads SET status = 'deleted', deleted_at = ${now}
      WHERE story_id IN (SELECT id FROM finished)
      RETURNING id
    `;
    const [storyRow] = await this.sql`SELECT status FROM stories WHERE id = ${storyId}`;
    if (!storyRow || string(storyRow, "status") !== "deleted") throw new Error("STORY_NOT_DELETING");
    void rows;
  }

  async listRuns(storyId: string) {
    const rows = await this.sql`SELECT * FROM story_runs WHERE story_id = ${storyId} ORDER BY updated_at ASC`;
    return rows.map(run);
  }

  async listUploadsByIds(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.sql`SELECT * FROM story_uploads WHERE id = ANY(${ids}) ORDER BY created_at ASC`;
    return rows.map(upload);
  }

  async claimExpiredPrivateStories(now: Date, staleBefore: Date, limit: number) {
    void staleBefore;
    const rows = await this.sql`
      WITH candidates AS MATERIALIZED (
        SELECT s.id FROM stories s JOIN owner_sessions o ON o.id = s.owner_session_id
        WHERE s.status NOT IN ('published', 'deleting', 'deleted')
          AND o.expires_at <= ${now}
        ORDER BY s.updated_at ASC FOR UPDATE OF s SKIP LOCKED LIMIT ${limit}
      ), cancelled AS (
        UPDATE story_runs SET status = 'cancelled', stage = 'retention-expired', finished_at = ${now}, updated_at = ${now}
        WHERE story_id IN (SELECT id FROM candidates) AND status IN ('queued', 'processing') RETURNING id
      )
      UPDATE stories SET status = 'deleting', public_slug = NULL, active_run_id = NULL, delete_after = ${now},
        manifest = NULL, updated_at = ${now}, version = version + 1
      WHERE id IN (SELECT id FROM candidates) RETURNING *
    `;
    return rows.map(story);
  }

  async listStoriesReadyForDeletion(now: Date, limit: number) {
    const rows = await this.sql`
      SELECT * FROM stories WHERE status = 'deleting' AND delete_after <= ${now} ORDER BY delete_after ASC LIMIT ${limit}
    `;
    return rows.map(story);
  }

  async purgeDeletedStories(deletedBefore: Date, limit: number) {
    const rows = await this.sql`
      WITH doomed AS MATERIALIZED (
        SELECT id, owner_session_id FROM stories WHERE status = 'deleted' AND deleted_at <= ${deletedBefore}
        ORDER BY deleted_at ASC LIMIT ${limit}
      ), deleted_uploads AS (
        DELETE FROM story_uploads WHERE story_id IN (SELECT id FROM doomed) RETURNING id
      ), deleted_runs AS (
        DELETE FROM story_runs WHERE story_id IN (SELECT id FROM doomed) RETURNING id
      ), deleted_stories AS (
        DELETE FROM stories WHERE id IN (SELECT id FROM doomed) RETURNING owner_session_id
      ), deleted_sessions AS (
        DELETE FROM owner_sessions o WHERE o.id IN (SELECT owner_session_id FROM deleted_stories)
          AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.owner_session_id = o.id) RETURNING id
      )
      SELECT count(*)::int AS count FROM deleted_stories
    `;
    return rows[0] ? number(rows[0], "count") : 0;
  }

  async expireStaleRuns(now: Date, staleBefore: Date, limit: number) {
    const rows = await this.sql`
      WITH stale AS MATERIALIZED (
        SELECT r.id, r.story_id FROM story_runs r JOIN stories s ON s.id = r.story_id AND s.active_run_id = r.id
        WHERE r.status IN ('queued', 'processing') AND s.status IN ('queued', 'processing') AND r.updated_at <= ${staleBefore}
        ORDER BY r.updated_at ASC FOR UPDATE OF r, s SKIP LOCKED LIMIT ${limit}
      ), failed_stories AS (
        UPDATE stories SET status = 'failed', active_run_id = NULL, updated_at = ${now}, version = version + 1
        WHERE id IN (SELECT story_id FROM stale) RETURNING id
      )
      UPDATE story_runs SET status = 'failed', stage = 'expired', error_code = 'PROCESSING_EXPIRED',
        error_message = 'Story processing expired before completion.', finished_at = ${now}, updated_at = ${now}
      WHERE id IN (SELECT id FROM stale) AND EXISTS (SELECT 1 FROM failed_stories) RETURNING *
    `;
    return rows.map(run);
  }

  async listRunsForDerivativeCleanup(limit: number) {
    const rows = await this.sql`
      SELECT * FROM story_runs WHERE status IN ('failed', 'cancelled') AND derivatives_deleted_at IS NULL
      ORDER BY updated_at ASC LIMIT ${limit}
    `;
    return rows.map(run);
  }

  async markRunDerivativesDeleted(runId: string, now: Date) {
    await this.sql`UPDATE story_runs SET derivatives_deleted_at = ${now}, updated_at = ${now} WHERE id = ${runId}`;
  }

  async createUpload(upload: StoryUpload) {
    await this.sql`
      INSERT INTO story_uploads (id, story_id, blob_path, original_name, declared_type, detected_type, byte_size, sha256, status, created_at, confirmed_at, deleted_at)
      VALUES (${upload.id}, ${upload.storyId}, ${upload.blobPath}, ${upload.originalName}, ${upload.declaredType}, ${upload.detectedType ?? null}, ${upload.byteSize ?? null}, ${upload.sha256 ?? null}, ${upload.status}, ${upload.createdAt}, ${upload.confirmedAt ?? null}, ${upload.deletedAt ?? null})
    `;
  }

  async reserveUpload(upload: StoryUpload, limits: UploadLimits) {
    const rows = await this.sql`
      WITH target AS MATERIALIZED (
        SELECT id FROM stories WHERE id = ${upload.storyId} AND status = 'uploading' FOR UPDATE
      ), capacity AS MATERIALIZED (
        SELECT target.id FROM target WHERE
          (SELECT count(*) FROM story_uploads WHERE story_id = target.id AND status IN ('reserved', 'confirmed')) < ${limits.maxPhotos}
          AND (SELECT coalesce(sum(byte_size), 0) FROM story_uploads WHERE story_id = target.id AND status IN ('reserved', 'confirmed')) + ${upload.byteSize ?? 0} <= ${limits.maxBytes}
      )
      INSERT INTO story_uploads (id, story_id, blob_path, original_name, declared_type, byte_size, status, created_at)
      SELECT ${upload.id}, ${upload.storyId}, ${upload.blobPath}, ${upload.originalName}, ${upload.declaredType}, ${upload.byteSize ?? null}, ${upload.status}, ${upload.createdAt}
      FROM capacity RETURNING id
    `;
    if (rows.length) return;
    const [current] = await this.sql`SELECT status FROM stories WHERE id = ${upload.storyId}`;
    if (!current || string(current, "status") !== "uploading") throw new Error("UPLOAD_STATE_CONFLICT");
    const [usage] = await this.sql`
      SELECT count(*)::int AS count, coalesce(sum(byte_size), 0)::float8 AS bytes FROM story_uploads
      WHERE story_id = ${upload.storyId} AND status IN ('reserved', 'confirmed')
    `;
    if (!usage) throw new Error("Upload capacity query returned no result.");
    if (number(usage, "count") >= limits.maxPhotos) throw new Error("UPLOAD_COUNT_LIMIT");
    throw new Error("UPLOAD_BYTES_LIMIT");
  }

  async findUpload(id: string) {
    const [row] = await this.sql`SELECT * FROM story_uploads WHERE id = ${id} LIMIT 1`;
    return row ? upload(row) : undefined;
  }

  async listUploads(storyId: string) {
    const rows = await this.sql`SELECT * FROM story_uploads WHERE story_id = ${storyId} ORDER BY created_at ASC`;
    return rows.map(upload);
  }

  async claimExpiredSourceUploads(now: Date, limit: number) {
    const rows = await this.sql`
      WITH candidates AS MATERIALIZED (
        SELECT u.id FROM story_uploads u JOIN stories s ON s.id = u.story_id
        WHERE u.deleted_at IS NULL
          AND (u.status IN ('reserved', 'confirmed') OR (u.status = 'rejected' AND u.cleanup_claimed_at <= ${new Date(now.getTime() - 15 * 60 * 1000)}))
          AND s.status NOT IN ('queued', 'processing') AND s.source_expires_at <= ${now}
        ORDER BY s.source_expires_at ASC FOR UPDATE OF s, u SKIP LOCKED LIMIT ${limit}
      )
      UPDATE story_uploads SET status = 'rejected', cleanup_claimed_at = ${now} WHERE id IN (SELECT id FROM candidates) RETURNING *
    `;
    return rows.map(upload);
  }

  async saveUpload(value: StoryUpload) {
    await this.sql`
      UPDATE story_uploads
      SET detected_type = ${value.detectedType ?? null}, byte_size = ${value.byteSize ?? null}, sha256 = ${value.sha256 ?? null},
          status = ${value.status}, confirmed_at = ${value.confirmedAt ?? null}, cleanup_claimed_at = ${value.cleanupClaimedAt ?? null}, deleted_at = ${value.deletedAt ?? null}
      WHERE id = ${value.id}
    `;
  }

  async confirmUpload(value: StoryUpload) {
    const rows = await this.sql`
      WITH target AS MATERIALIZED (
        SELECT id FROM stories WHERE id = ${value.storyId} AND status = 'uploading' FOR UPDATE
      )
      UPDATE story_uploads SET detected_type = ${value.detectedType ?? null}, status = 'confirmed', confirmed_at = ${value.confirmedAt ?? null}
      WHERE id = ${value.id} AND story_id IN (SELECT id FROM target) AND status = 'reserved'
      RETURNING id
    `;
    if (!rows.length) throw new Error("UPLOAD_STATE_CONFLICT");
  }
}

function session(row: Row): OwnerSession {
  return {
    id: string(row, "id"),
    secretHash: string(row, "secret_hash"),
    csrfToken: string(row, "csrf_token"),
    createdAt: date(row, "created_at"),
    lastSeenAt: date(row, "last_seen_at"),
    expiresAt: date(row, "expires_at"),
    revokedAt: optionalDate(row, "revoked_at"),
    termsVersion: string(row, "terms_version"),
    uploadConsentVersion: string(row, "upload_consent_version"),
  };
}

function story(row: Row): Story {
  return {
    id: string(row, "id"),
    ownerSessionId: string(row, "owner_session_id"),
    admissionKey: optionalString(row, "admission_key"),
    publicSlug: optionalString(row, "public_slug"),
    status: string(row, "status") as Story["status"],
    title: string(row, "title"),
    peopleMode: string(row, "people_mode") as Story["peopleMode"],
    locationPrivacy: string(row, "location_privacy") as Story["locationPrivacy"],
    manifest: optionalJson(row, "manifest") as Story["manifest"],
    processorRevision: string(row, "processor_revision"),
    activeRunId: optionalString(row, "active_run_id"),
    sourceExpiresAt: date(row, "source_expires_at"),
    publishedAt: optionalDate(row, "published_at"),
    createdAt: date(row, "created_at"),
    updatedAt: date(row, "updated_at"),
    deleteAfter: optionalDate(row, "delete_after"),
    deletedAt: optionalDate(row, "deleted_at"),
    version: number(row, "version"),
  };
}

function run(row: Row): StoryRun {
  return {
    id: string(row, "id"),
    storyId: string(row, "story_id"),
    workflowRunId: optionalString(row, "workflow_run_id"),
    processorRevision: string(row, "processor_revision"),
    admissionKey: optionalString(row, "admission_key"),
    status: string(row, "status") as StoryRun["status"],
    stage: string(row, "stage"),
    progress: number(row, "progress"),
    attempts: number(row, "attempts"),
    errorCode: optionalString(row, "error_code"),
    errorMessage: optionalString(row, "error_message"),
    startedAt: optionalDate(row, "started_at"),
    finishedAt: optionalDate(row, "finished_at"),
    derivativesDeletedAt: optionalDate(row, "derivatives_deleted_at"),
    sourceUploadIds: Array.isArray(row.source_upload_ids) ? row.source_upload_ids.map(value => String(value)) : [],
    updatedAt: date(row, "updated_at"),
  };
}

function upload(row: Row): StoryUpload {
  const declaredType = string(row, "declared_type");
  if (declaredType !== "image/jpeg" && declaredType !== "image/png" && declaredType !== "image/webp")
    throw new Error("Database value declared_type is invalid.");
  return {
    id: string(row, "id"),
    storyId: string(row, "story_id"),
    blobPath: string(row, "blob_path"),
    originalName: string(row, "original_name"),
    declaredType,
    detectedType: optionalString(row, "detected_type"),
    byteSize: row.byte_size == null ? undefined : number(row, "byte_size"),
    sha256: optionalString(row, "sha256"),
    status: string(row, "status") as StoryUpload["status"],
    createdAt: date(row, "created_at"),
    confirmedAt: optionalDate(row, "confirmed_at"),
    cleanupClaimedAt: optionalDate(row, "cleanup_claimed_at"),
    deletedAt: optionalDate(row, "deleted_at"),
  };
}

function string(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Database value ${key} is invalid.`);
  return value;
}
function optionalString(row: Row, key: string) {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}
function number(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Database value ${key} is invalid.`);
  return value;
}
function date(row: Row, key: string) {
  const value = row[key];
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Database value ${key} is invalid.`);
  return parsed;
}
function optionalDate(row: Row, key: string) {
  return row[key] == null ? undefined : date(row, key);
}
function optionalJson(row: Row, key: string) {
  const value = row[key];
  if (value == null) return undefined;
  return typeof value === "string" ? JSON.parse(value) : value;
}
