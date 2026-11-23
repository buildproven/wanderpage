-- One-time links from the hosted MCP tool upload_photos to a story's private page (BUI-2095).
-- The sealed link carries the owner session; this row holds only its id, story, expiry and used time.
CREATE TABLE upload_links (
  id uuid PRIMARY KEY,
  story_id uuid NOT NULL REFERENCES stories(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX upload_links_story_id_idx ON upload_links (story_id);
