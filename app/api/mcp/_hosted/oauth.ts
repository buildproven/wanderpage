// @design DES-WEB-MCP
// The owner-only OAuth authorization server for the hosted MCP entry (BUI-2099), from @buildproven/mcp-oauth with prefix WANDERPAGE.
// It is built on first use so that a build or an import needs no settings; each handler reads its settings per request and answers a
// 500 or 503 naming any that is missing.
import { createOAuthServer, type OAuthServer } from "@buildproven/mcp-oauth";
import { PostgresGrantStore } from "@/lib/web/grant-store";
import { hostedPrefix } from "@/app/api/mcp/_hosted/http";

let server: OAuthServer | undefined;

export function hostedOAuth() {
  server ??= createOAuthServer({ prefix: hostedPrefix, grantStore: PostgresGrantStore.fromEnvironment() });
  return server;
}
