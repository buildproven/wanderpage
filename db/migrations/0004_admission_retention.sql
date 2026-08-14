ALTER TABLE story_runs ADD COLUMN admitted_at timestamptz;
UPDATE story_runs SET admitted_at = updated_at WHERE admitted_at IS NULL;
ALTER TABLE story_runs ALTER COLUMN admitted_at SET NOT NULL;

DROP INDEX story_runs_admission_window_idx;
CREATE INDEX story_runs_admission_window_idx
  ON story_runs (admission_key, admitted_at DESC)
  WHERE admission_key IS NOT NULL;
