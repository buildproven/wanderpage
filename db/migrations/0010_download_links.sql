-- One-time links from the hosted MCP tool download_page to a story's download page (BUI-2146).
-- The sealed link carries the owner session; this row holds only its id, story, expiry and used time.
CREATE TABLE download_links (
  id uuid PRIMARY KEY,
  story_id uuid NOT NULL REFERENCES stories(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX download_links_story_id_idx ON download_links (story_id);
