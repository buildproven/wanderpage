CREATE TYPE story_status AS ENUM ('uploading', 'queued', 'processing', 'draft', 'published', 'failed', 'deleting', 'deleted');
CREATE TYPE run_status AS ENUM ('queued', 'processing', 'complete', 'failed', 'cancelled');

CREATE TABLE owner_sessions (
  id uuid PRIMARY KEY,
  secret_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  terms_version text NOT NULL,
  upload_consent_version text NOT NULL
);

CREATE TABLE stories (
  id uuid PRIMARY KEY,
  owner_session_id uuid NOT NULL REFERENCES owner_sessions(id),
  public_slug text UNIQUE,
  status story_status NOT NULL,
  title text NOT NULL,
  people_mode text NOT NULL CHECK (people_mode IN ('include', 'exclude')),
  location_privacy text NOT NULL CHECK (location_privacy IN ('broad', 'approximate', 'hidden')),
  manifest jsonb,
  processor_revision text NOT NULL,
  active_run_id uuid,
  source_expires_at timestamptz NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 0
);

CREATE INDEX stories_owner_updated_idx ON stories (owner_session_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE story_uploads (
  id uuid PRIMARY KEY,
  story_id uuid NOT NULL REFERENCES stories(id),
  blob_path text NOT NULL UNIQUE,
  original_name text NOT NULL,
  declared_type text NOT NULL,
  detected_type text,
  byte_size bigint,
  sha256 text,
  status text NOT NULL CHECK (status IN ('reserved', 'confirmed', 'rejected', 'deleted')),
  created_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE story_runs (
  id uuid PRIMARY KEY,
  story_id uuid NOT NULL REFERENCES stories(id),
  workflow_run_id text UNIQUE,
  processor_revision text NOT NULL,
  status run_status NOT NULL,
  stage text NOT NULL,
  progress smallint NOT NULL CHECK (progress BETWEEN 0 AND 100),
  attempts smallint NOT NULL,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX stories_one_active_run_idx ON stories (owner_session_id) WHERE status IN ('queued', 'processing');
