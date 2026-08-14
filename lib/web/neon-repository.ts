import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { OwnerSession, Story, StoryRepository, StoryRun, StoryUpload } from "@/lib/web/types";

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

  async findSessionBySecretHash(secretHash: string) {
    const [row] = await this.sql`SELECT * FROM owner_sessions WHERE secret_hash = ${secretHash} LIMIT 1`;
    return row ? session(row) : undefined;
  }

  async touchSession(id: string, lastSeenAt: Date) {
    await this.sql`UPDATE owner_sessions SET last_seen_at = ${lastSeenAt} WHERE id = ${id} AND revoked_at IS NULL`;
  }

  async createStory(story: Story) {
    await this.sql`
      INSERT INTO stories (id, owner_session_id, public_slug, status, title, people_mode, location_privacy, manifest, processor_revision, active_run_id, source_expires_at, published_at, created_at, updated_at, deleted_at, version)
      VALUES (${story.id}, ${story.ownerSessionId}, ${story.publicSlug ?? null}, ${story.status}, ${story.title}, ${story.peopleMode}, ${story.locationPrivacy}, ${story.manifest ?? null}, ${story.processorRevision}, ${story.activeRunId ?? null}, ${story.sourceExpiresAt}, ${story.publishedAt ?? null}, ${story.createdAt}, ${story.updatedAt}, ${story.deletedAt ?? null}, ${story.version})
    `;
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

  async createRun(run: StoryRun) {
    await this.sql`
      INSERT INTO story_runs (id, story_id, workflow_run_id, processor_revision, status, stage, progress, attempts, error_code, error_message, started_at, finished_at, updated_at)
      VALUES (${run.id}, ${run.storyId}, ${run.workflowRunId ?? null}, ${run.processorRevision}, ${run.status}, ${run.stage}, ${run.progress}, ${run.attempts}, ${run.errorCode ?? null}, ${run.errorMessage ?? null}, ${run.startedAt ?? null}, ${run.finishedAt ?? null}, ${run.updatedAt})
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

  async createUpload(upload: StoryUpload) {
    await this.sql`
      INSERT INTO story_uploads (id, story_id, blob_path, original_name, declared_type, detected_type, byte_size, sha256, status, created_at, confirmed_at, deleted_at)
      VALUES (${upload.id}, ${upload.storyId}, ${upload.blobPath}, ${upload.originalName}, ${upload.declaredType}, ${upload.detectedType ?? null}, ${upload.byteSize ?? null}, ${upload.sha256 ?? null}, ${upload.status}, ${upload.createdAt}, ${upload.confirmedAt ?? null}, ${upload.deletedAt ?? null})
    `;
  }

  async findUpload(id: string) {
    const [row] = await this.sql`SELECT * FROM story_uploads WHERE id = ${id} LIMIT 1`;
    return row ? upload(row) : undefined;
  }

  async listUploads(storyId: string) {
    const rows = await this.sql`SELECT * FROM story_uploads WHERE story_id = ${storyId} ORDER BY created_at ASC`;
    return rows.map(upload);
  }

  async saveUpload(value: StoryUpload) {
    await this.sql`
      UPDATE story_uploads
      SET detected_type = ${value.detectedType ?? null}, byte_size = ${value.byteSize ?? null}, sha256 = ${value.sha256 ?? null},
          status = ${value.status}, confirmed_at = ${value.confirmedAt ?? null}, deleted_at = ${value.deletedAt ?? null}
      WHERE id = ${value.id}
    `;
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
    status: string(row, "status") as StoryRun["status"],
    stage: string(row, "stage"),
    progress: number(row, "progress"),
    attempts: number(row, "attempts"),
    errorCode: optionalString(row, "error_code"),
    errorMessage: optionalString(row, "error_message"),
    startedAt: optionalDate(row, "started_at"),
    finishedAt: optionalDate(row, "finished_at"),
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
