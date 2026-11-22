// @design DES-WEB-MCP
// Production wiring of the hosted MCP entry (BUI-2099): Neon owner sessions and bindings, the hosted StoryService, and the token check.
import { neon } from "@neondatabase/serverless";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { getStoryService } from "@/lib/web/runtime";
import { hashSecret } from "@/lib/web/story-service";
import { configurationProblem, createHostedMcpHandler, type HostedDependencies } from "@/app/api/mcp/_hosted/http";
import { HostedOwnerSessions, minimumSessionKeyLength, PostgresOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";

const required = ["DATABASE_URL", "WANDERPAGE_SESSION_PEPPER", "WANDERPAGE_MCP_SESSION_KEY"] as const;
let dependencies: HostedDependencies | undefined;

/** The hosted dependencies, built once, or a 503 naming each missing or unusable setting. */
export function hostedDependencies(env: Readonly<Record<string, string | undefined>> = process.env): HostedDependencies | Response {
  if (dependencies) return dependencies;
  const [url, pepper, key] = required.map(name => env[name]?.trim() ?? "") as [string, string, string],
    missing = required.filter((_, index) => ![url, pepper, key][index]);
  if (missing.length) return configurationProblem(missing, []);
  if (key.length < minimumSessionKeyLength)
    return configurationProblem([], ["WANDERPAGE_MCP_SESSION_KEY"], `shorter than ${minimumSessionKeyLength} characters`);
  const sql = neon(url),
    stories = getStoryService();
  dependencies = {
    stories,
    sessions: new HostedOwnerSessions({
      service: stories,
      repository: new NeonStoryRepository(sql),
      bindings: new PostgresOwnerBindingStore(sql),
      key,
      hashSecret: secret => hashSecret(secret, pepper),
    }),
  };
  return dependencies;
}

export const hostedMcpHandler = createHostedMcpHandler({ dependencies: () => hostedDependencies() });
