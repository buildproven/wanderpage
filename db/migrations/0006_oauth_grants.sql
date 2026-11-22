-- Spent OAuth authorization codes and refresh tokens for the hosted MCP sign-in (BUI-2099).
-- The primary key makes a claim succeed once; expired rows are pruned on the next claim.
CREATE TABLE oauth_grants (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE INDEX oauth_grants_expires_idx ON oauth_grants (expires_at);
