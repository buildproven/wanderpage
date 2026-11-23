-- Who each owner session belongs to (BUI-2136): 'public' for the anonymous web creator, 'owner' for the signed-in hosted MCP owner.
-- StoryService admits owner sessions while public creation (WANDERPAGE_GENERATION_ENABLED) is off. Existing rows default to 'public';
-- the sessions bound to an MCP owner (migration 0007) are the owner's.
ALTER TABLE owner_sessions ADD COLUMN kind text NOT NULL DEFAULT 'public' CHECK (kind IN ('public', 'owner'));
UPDATE owner_sessions SET kind = 'owner' WHERE id IN (SELECT owner_session_id FROM mcp_owner_bindings);
