ALTER TABLE story_runs ADD COLUMN admission_key text;
ALTER TABLE story_runs ADD COLUMN derivatives_deleted_at timestamptz;
ALTER TABLE stories ADD COLUMN admission_key text;

CREATE INDEX story_runs_admission_window_idx
  ON story_runs (admission_key, updated_at DESC)
  WHERE admission_key IS NOT NULL;

CREATE INDEX stories_admission_window_idx
  ON stories (admission_key, created_at DESC)
  WHERE admission_key IS NOT NULL;
