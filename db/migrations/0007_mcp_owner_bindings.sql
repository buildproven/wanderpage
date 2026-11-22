-- The hosted MCP owner's OAuth subject (as a keyed hash) and the owner session it uses (BUI-2099).
-- No foreign key: retention revokes and purges owner sessions, and the MCP layer binds a new session when its session is gone.
CREATE TABLE mcp_owner_bindings (
  subject_hash text PRIMARY KEY,
  owner_session_id uuid NOT NULL,
  bound_at timestamptz NOT NULL
);
