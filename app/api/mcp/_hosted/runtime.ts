// @design DES-WEB-MCP
// Production wiring of the hosted MCP entry (BUI-2099): Neon owner sessions and bindings, the hosted StoryService, and the token check.
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { getStoryService } from "@/lib/web/runtime";
import { hashSecret } from "@/lib/web/story-service";
import { configurationProblem, createHostedMcpHandler, type HostedDependencies } from "@/app/api/mcp/_hosted/http";
import { HostedOwnerSessions, PostgresOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";

const required = ["DATABASE_URL", "WANDERPAGE_SESSION_PEPPER"] as const;

/**
 * The owner-session key, derived from the session pepper under its own label (HMAC key separation), so the hosted MCP needs no extra
 * secret. Rotating the pepper starts a new, empty owner session, as it already ends every web owner session.
 */
export function mcpSessionKey(pepper: string) {
  return createHmac("sha256", pepper).update("wanderpage-mcp-owner-session-key-v1").digest("base64url");
}
let dependencies: HostedDependencies | undefined;

/** The hosted dependencies, built once, or a 503 naming each missing or unusable setting. */
export function hostedDependencies(env: Readonly<Record<string, string | undefined>> = process.env): HostedDependencies | Response {
  if (dependencies) return dependencies;
  const [url, pepper] = required.map(name => env[name]?.trim() ?? "") as [string, string],
    missing = required.filter((_, index) => ![url, pepper][index]);
  if (missing.length) return configurationProblem(missing, []);
  const sql = neon(url),
    stories = getStoryService();
  dependencies = {
    stories,
    sessions: new HostedOwnerSessions({
      service: stories,
      repository: new NeonStoryRepository(sql),
      bindings: new PostgresOwnerBindingStore(sql),
      key: mcpSessionKey(pepper),
      hashSecret: secret => hashSecret(secret, pepper),
    }),
  };
  return dependencies;
}

export const hostedMcpHandler = createHostedMcpHandler({ dependencies: () => hostedDependencies() });
