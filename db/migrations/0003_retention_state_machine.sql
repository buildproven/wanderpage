ALTER TABLE story_runs ADD COLUMN source_upload_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE story_uploads ADD COLUMN cleanup_claimed_at timestamptz;
ALTER TABLE stories ADD COLUMN delete_after timestamptz;

CREATE INDEX stories_private_retention_idx
  ON stories (updated_at)
  WHERE status NOT IN ('published', 'deleting', 'deleted');

CREATE INDEX stories_delete_queue_idx
  ON stories (delete_after)
  WHERE status = 'deleting';
