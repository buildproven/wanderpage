import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as authorizationServer from "@/app/.well-known/oauth-authorization-server/route";
import * as protectedResource from "@/app/.well-known/oauth-protected-resource/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as authorize from "@/app/oauth/authorize/route";
import * as githubCallback from "@/app/oauth/github/callback/route";
import * as jwks from "@/app/oauth/jwks/route";
import * as register from "@/app/oauth/register/route";
import * as token from "@/app/oauth/token/route";
import { hostedDependencies } from "@/app/api/mcp/_hosted/runtime";
import { createServer } from "@/mcp/server";

const origin = "https://wander.test";

afterEach(() => {
  vi.unstubAllEnvs();
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY
describe("hosted MCP OAuth routes (BUI-2099)", () => {
  it("BUI-2099 R1: serves RFC 8414 metadata from @buildproven/mcp-oauth under the WANDERPAGE prefix", async () => {
    vi.stubEnv("WANDERPAGE_OAUTH_ISSUER", `${origin}/`);
    const response = authorizationServer.GET(new Request(`${origin}/.well-known/oauth-authorization-server`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      jwks_uri: `${origin}/oauth/jwks`,
    });
  });

  it("BUI-2099 R1: an /oauth endpoint without its WANDERPAGE setting names the setting, never a value", async () => {
    vi.stubEnv("WANDERPAGE_OAUTH_ISSUER", origin);
    vi.stubEnv("WANDERPAGE_OAUTH_SIGNING_KEY", "");
    const response = await jwks.GET(new Request(`${origin}/oauth/jwks`)),
      body = JSON.stringify(await response.json());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(body).toContain("WANDERPAGE_OAUTH_SIGNING_KEY");
  });

  it("BUI-2099 R1: mounts every /oauth handler and the CORS preflights", () => {
    expect(typeof authorize.GET).toBe("function");
    expect(typeof githubCallback.GET).toBe("function");
    expect(typeof jwks.GET).toBe("function");
    expect(typeof register.POST).toBe("function");
    expect(typeof token.POST).toBe("function");
    for (const preflight of [jwks.OPTIONS(), register.OPTIONS(), token.OPTIONS(), authorizationServer.OPTIONS()])
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect([typeof mcpRoute.GET, typeof mcpRoute.POST, typeof mcpRoute.DELETE]).toEqual(["function", "function", "function"]);
  });

  it("BUI-2099 R1: protected resource metadata names this deployment's MCP URL and the issuer", async () => {
    vi.stubEnv("WANDERPAGE_OAUTH_ISSUER", `${origin}/`);
    const response = protectedResource.GET(
      new Request(`${origin}/.well-known/oauth-protected-resource`, { headers: { "x-forwarded-host": "evil.test" } })
    );
    expect(await response.json()).toEqual({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Wanderpage",
    });
  });

  it("BUI-2099 R1: protected resource metadata answers 503 for a missing or non-https issuer", async () => {
    vi.stubEnv("WANDERPAGE_OAUTH_ISSUER", "");
    const missing = protectedResource.GET(new Request(`${origin}/.well-known/oauth-protected-resource`));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ missing: ["WANDERPAGE_OAUTH_ISSUER"] });
    vi.stubEnv("WANDERPAGE_OAUTH_ISSUER", "http://wander.test");
    const insecure = protectedResource.GET(new Request(`${origin}/.well-known/oauth-protected-resource`));
    expect(insecure.status).toBe(503);
    expect(await insecure.json()).toMatchObject({ invalid: ["WANDERPAGE_OAUTH_ISSUER"] });
  });

  it("BUI-2099 R1: /api/mcp answers 401 with the resource_metadata pointer before it needs a database", async () => {
    vi.stubEnv("WANDERPAGE_OAUTH_ISSUER", origin);
    vi.stubEnv("WANDERPAGE_OAUTH_JWKS_URL", `${origin}/oauth/jwks`);
    vi.stubEnv("WANDERPAGE_OWNER_SUBJECT", "owner-login");
    vi.stubEnv("DATABASE_URL", "");
    const response = await mcpRoute.POST(new Request(`${origin}/api/mcp`, { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
  });

  it("BUI-2099 R3: the hosted runtime names each missing setting, and a short session key, instead of starting", async () => {
    const missing = hostedDependencies({ DATABASE_URL: "postgres://db.test/wander" });
    expect(missing).toBeInstanceOf(Response);
    expect(await (missing as Response).json()).toMatchObject({ missing: ["WANDERPAGE_SESSION_PEPPER", "WANDERPAGE_MCP_SESSION_KEY"] });
    const short = hostedDependencies({
      DATABASE_URL: "postgres://db.test/wander",
      WANDERPAGE_SESSION_PEPPER: "pepper",
      WANDERPAGE_MCP_SESSION_KEY: "tiny-key",
    });
    expect((short as Response).status).toBe(503);
    const body = JSON.stringify(await (short as Response).json());
    expect(body).toContain("WANDERPAGE_MCP_SESSION_KEY");
    expect(body).not.toContain("tiny-key");
    expect(body).not.toContain("db.test");
  });

  it("BUI-2099 R6: the static export leaves out app/oauth with the other server-only routes", async () => {
    const source = await readFile("scripts/static-export.ts", "utf8"),
      list = /for \(const serverOnly of \[([^\]]*)\]\)/.exec(source)?.[1] ?? "",
      removed = [...list.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    expect(removed).toEqual(expect.arrayContaining(["app/oauth", "app/api", "app/.well-known"]));
    expect(source).toContain('rm(join(buildRoot, "lib/web")');
  });

  it("BUI-2099 R5: the stdio entry still serves the local draft tools and none of the hosted ones", async () => {
    const server = createServer({ root: "/nonexistent-wanderpage-root" }),
      client = new Client({ name: "stdio-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("create_draft");
    expect(names).not.toContain("list_stories");
    expect(names).not.toContain("get_story");
  });

  it("BUI-2099 R6: app code imports nothing from mcp/, which the site scaffold and the static export never copy", async () => {
    const files = (await readdir("app", { recursive: true })).filter(file => /\.(ts|tsx)$/.test(file)),
      offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(join("app", file), "utf8");
      if (/from\s+["'](?:@\/mcp\/|(?:\.\.\/)+mcp\/)/.test(source)) offenders.push(file);
    }
    expect(files).toContain(join("api", "mcp", "route.ts"));
    expect(offenders).toEqual([]);
  });
});
