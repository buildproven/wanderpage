import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import { createHostedMcpHandler } from "@/app/api/mcp/_hosted/http";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const origin = "https://wander.test",
  owner = "owner-login",
  env = {
    WANDERPAGE_OAUTH_ISSUER: origin,
    WANDERPAGE_OAUTH_JWKS_URL: `${origin}/oauth/jwks`,
    WANDERPAGE_OWNER_SUBJECT: owner,
  },
  storyInput = {
    title: "Lisbon in spring",
    peopleMode: "exclude" as const,
    locationPrivacy: "broad" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

let signingKey: CryptoKey, keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256" }] });
});

function mint(subject: string) {
  return new SignJWT({ scope: "mcp", client_id: "client-1" })
    .setProtectedHeader({ alg: "ES256", kid: "test-key", typ: "at+jwt" })
    .setIssuer(origin)
    .setAudience(`${origin}/api/mcp`)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

function fixture() {
  const repository = new MemoryStoryRepository(),
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit: 25 })
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    handle = createHostedMcpHandler({ env, keys, dependencies: () => ({ stories, sessions }) });
  return { repository, stories, sessions, handle };
}

const listRequest = (authorization?: string) =>
  new Request(`${origin}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

async function httpClient(handle: (request: Request) => Promise<Response>, bearer: string) {
  const client = new Client({ name: "hosted-test", version: "1.0.0" }),
    transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: (input, init) => handle(new Request(input, init)),
    });
  await client.connect(transport);
  return client;
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("hosted MCP sign-in (BUI-2099)", () => {
  it("BUI-2099 R1: answers 401 with the resource_metadata pointer when no token is sent", async () => {
    const { handle } = fixture(),
      response = await handle(listRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
  });

  it("BUI-2099 R1: answers 401 for a token the issuer did not sign", async () => {
    const { handle } = fixture(),
      other = await generateKeyPair("ES256"),
      forged = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: "test-key" })
        .setIssuer(origin)
        .setAudience(`${origin}/api/mcp`)
        .setSubject(owner)
        .setExpirationTime("5m")
        .sign(other.privateKey),
      response = await handle(listRequest(`Bearer ${forged}`));
    expect(response.status).toBe(401);
  });

  it("BUI-2099 R4: refuses a valid token for another subject and binds no session for it", async () => {
    const { handle, sessions } = fixture(),
      binding = vi.spyOn(sessions, "secretFor"),
      response = await handle(listRequest(`Bearer ${await mint("someone-else")}`));
    expect(response.status).toBe(403);
    expect(binding).not.toHaveBeenCalled();
  });

  it("BUI-2099 R4: a server built for another subject refuses every story tool", async () => {
    const { stories, sessions } = fixture(),
      ownerSecret = await sessions.secretFor(owner);
    await stories.createStory(ownerSecret, storyInput);
    const server = createHostedServer({ stories, sessions, subject: "someone-else", ownerSubject: owner }),
      client = new Client({ name: "hosted-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const response = await client.callTool({ name: "list_stories", arguments: {} }),
      text = (response.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(response.isError).toBe(true);
    expect(text).toContain("only its owner");
    expect(text).not.toContain("Lisbon");
  });

  it("BUI-2099 R1, R3, R4: the owner's valid token reaches list_stories and sees the owner's story", async () => {
    const { handle, stories, sessions } = fixture(),
      ownerSecret = await sessions.secretFor(owner),
      story = await stories.createStory(ownerSecret, storyInput),
      client = await httpClient(handle, await mint(owner)),
      { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["get_story", "list_stories"]);
    const response = await client.callTool({ name: "list_stories", arguments: {} });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({
      stories: [expect.objectContaining({ id: story.id, title: "Lisbon in spring", status: "uploading", published: false })],
    });
    await client.close();
  });

  it("BUI-2099 R1: answers 503 naming a missing setting before any tool runs", async () => {
    const { stories, sessions } = fixture(),
      handle = createHostedMcpHandler({
        env: { WANDERPAGE_OAUTH_ISSUER: origin, WANDERPAGE_OAUTH_JWKS_URL: `${origin}/oauth/jwks` },
        keys,
        dependencies: () => ({ stories, sessions }),
      }),
      response = await handle(listRequest(`Bearer ${await mint(owner)}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ missing: ["WANDERPAGE_OWNER_SUBJECT"] });
  });
});
