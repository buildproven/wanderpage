import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import PrivacyPage from "@/app/privacy/page";
import Landing from "@/components/Landing";
import { currentDisclosureVersion, uploadConsentText } from "@/lib/consent";
import { minStoryPhotos } from "@/lib/web/limits";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService, type GenerationPolicy } from "@/lib/web/story-service";
import { createHostedMcpHandler } from "@/app/api/mcp/_hosted/http";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const origin = "https://wander.test",
  owner = "Owner-Login",
  openEnv = {
    WANDERPAGE_OAUTH_ISSUER: origin,
    WANDERPAGE_OAUTH_JWKS_URL: `${origin}/oauth/jwks`,
    WANDERPAGE_SIGNUP: "open",
  },
  createArgs = { title: "A trip", peopleMode: "exclude", locationPrivacy: "broad" };

let signingKey: CryptoKey, keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256" }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
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

function services(policy: GenerationPolicy = { enabled: true, dailyLimit: 25 }) {
  const repository = new MemoryStoryRepository(),
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => policy,
      async () => undefined
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    });
  return { repository, stories, sessions };
}

async function httpClient(handle: (request: Request) => Promise<Response>, subject: string) {
  const bearer = await mint(subject),
    client = new Client({ name: "open-signup-test", version: "1.0.0" }),
    transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: (input, init) => handle(new Request(input, init)),
    });
  await client.connect(transport);
  return client;
}

async function memoryClient(server: ReturnType<typeof createHostedServer>) {
  const client = new Client({ name: "open-signup-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

function visibleText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "’")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim();
}

const claudeSection = (html: string) => /<section[^>]*aria-labelledby="claude-title"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("hosted MCP open signup (BUI-2215)", () => {
  it("BUI-2215 R1: with WANDERPAGE_SIGNUP=open, two GitHub users each get their own session and see only their own stories", async () => {
    const context = services(),
      handle = createHostedMcpHandler({
        env: openEnv,
        keys,
        dependencies: () => ({ stories: context.stories, sessions: context.sessions }),
      }),
      alice = await httpClient(handle, "alice"),
      bob = await httpClient(handle, "bob"),
      aliceStory = await call(alice, "create_story", { ...createArgs, title: "Alice in Oslo" }),
      bobStory = await call(bob, "create_story", { ...createArgs, title: "Bob in Rome" });
    expect(aliceStory.isError, aliceStory.text).toBe(false);
    expect(bobStory.isError, bobStory.text).toBe(false);
    const aliceId = aliceStory.data?.id as string,
      bobId = bobStory.data?.id as string;

    const aliceList = await call(alice, "list_stories"),
      bobList = await call(bob, "list_stories");
    expect((aliceList.data?.stories as Array<{ id: string }>).map(story => story.id)).toEqual([aliceId]);
    expect((bobList.data?.stories as Array<{ id: string }>).map(story => story.id)).toEqual([bobId]);

    const aliceReadsBob = await call(alice, "get_story", { storyId: bobId }),
      bobReadsAlice = await call(bob, "get_story", { storyId: aliceId });
    expect(aliceReadsBob.isError).toBe(true);
    expect(aliceReadsBob.text).not.toContain("Bob in Rome");
    expect(bobReadsAlice.isError).toBe(true);
    expect(bobReadsAlice.text).not.toContain("Alice in Oslo");
    expect((await call(alice, "get_story", { storyId: aliceId })).data).toMatchObject({ id: aliceId, title: "Alice in Oslo" });

    // Each subject has its own owner session and its own admission key, so one user's limits never count another's stories.
    const aliceRecord = await context.repository.findStory(aliceId),
      bobRecord = await context.repository.findStory(bobId);
    expect(aliceRecord?.ownerSessionId).toBeDefined();
    expect(aliceRecord?.ownerSessionId).not.toBe(bobRecord?.ownerSessionId);
    expect(aliceRecord?.admissionKey).toBe(context.sessions.admissionKeyFor("alice"));
    expect(bobRecord?.admissionKey).toBe(context.sessions.admissionKeyFor("bob"));
    await Promise.all([alice.close(), bob.close()]);
  });

  it("BUI-2215 R1: in open mode the owner's lower-case login keeps the owner's existing session and stories", async () => {
    const context = services(),
      ownerSecret = await context.sessions.secretFor(owner),
      before = await context.stories.createStory(ownerSecret, {
        title: "Owner before open signup",
        peopleMode: "exclude",
        locationPrivacy: "broad",
        termsVersion: currentDisclosureVersion,
        uploadConsentVersion: currentDisclosureVersion,
      }),
      handle = createHostedMcpHandler({
        env: { ...openEnv, WANDERPAGE_OWNER_SUBJECT: owner },
        keys,
        dependencies: () => ({ stories: context.stories, sessions: context.sessions }),
      }),
      // mcp-oauth signs an open-mode token with the GitHub login in lower case.
      client = await httpClient(handle, owner.toLowerCase()),
      listed = await call(client, "list_stories");
    expect(listed.isError, listed.text).toBe(false);
    expect((listed.data?.stories as Array<{ id: string }>).map(story => story.id)).toEqual([before.id]);
    await client.close();
  });

  it("BUI-2215 R1: without WANDERPAGE_SIGNUP=open, another GitHub user is still refused", async () => {
    const context = services(),
      handle = createHostedMcpHandler({
        env: { ...openEnv, WANDERPAGE_SIGNUP: undefined, WANDERPAGE_OWNER_SUBJECT: owner },
        keys,
        dependencies: () => ({ stories: context.stories, sessions: context.sessions }),
      }),
      response = await handle(
        new Request(`${origin}/api/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${await mint("alice")}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        })
      );
    expect(response.status).toBe(403);
  });

  it("BUI-2215 R1: unsetting WANDERPAGE_SIGNUP stops another account at once, even with a token from open mode, and the owner keeps working", async () => {
    const context = services(),
      env: Record<string, string | undefined> = { ...openEnv, WANDERPAGE_OWNER_SUBJECT: owner },
      handle = createHostedMcpHandler({ env, keys, dependencies: () => ({ stories: context.stories, sessions: context.sessions }) }),
      alice = await httpClient(handle, "alice"),
      created = await call(alice, "create_story", createArgs);
    expect(created.isError, created.text).toBe(false);
    const aliceToken = await mint("alice"),
      ownerClient = await httpClient(handle, owner);
    env.WANDERPAGE_SIGNUP = undefined;
    const response = await handle(
      new Request(`${origin}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_story", arguments: createArgs } }),
      })
    );
    expect(response.status).toBe(403);
    expect((await call(ownerClient, "create_story", { ...createArgs, title: "Owner trip" })).isError).toBe(false);
    const aliceRecord = await context.repository.findStory(created.data?.id as string);
    expect(aliceRecord).toBeDefined();
    expect(await context.repository.listStories(aliceRecord?.ownerSessionId ?? "")).toHaveLength(1);
    await Promise.all([alice.close(), ownerClient.close()]);
  });

  it("BUI-2215 R1: WANDERPAGE_OWNER_GENERATION_ENABLED=false refuses another account's writes with a visible message", async () => {
    const context = services({ enabled: false, ownerEnabled: false, dailyLimit: 25 }),
      client = await memoryClient(
        createHostedServer({ stories: context.stories, sessions: context.sessions, subject: "alice", ownerSubject: owner, signup: "open" })
      ),
      refused = await call(client, "create_story", createArgs);
    expect(refused).toMatchObject({ isError: true, text: "Story creation is temporarily unavailable." });
    expect((await call(client, "list_stories")).data).toEqual({ stories: [] });
  });

  it("BUI-2215 R1: opening signup needs no public creation switch, so the anonymous web creator stays closed", async () => {
    // The production default: WANDERPAGE_GENERATION_ENABLED off, WANDERPAGE_OWNER_GENERATION_ENABLED unset (on).
    const context = services({ enabled: false, ownerEnabled: true, dailyLimit: 25 }),
      client = await memoryClient(
        createHostedServer({ stories: context.stories, sessions: context.sessions, subject: "alice", ownerSubject: owner, signup: "open" })
      ),
      created = await call(client, "create_story", createArgs);
    expect(created.isError, created.text).toBe(false);
    await expect(
      context.stories.createSessionWithStory(
        {
          ...createArgs,
          peopleMode: "exclude",
          locationPrivacy: "broad",
          termsVersion: currentDisclosureVersion,
          uploadConsentVersion: currentDisclosureVersion,
        },
        "anonymous-client"
      )
    ).rejects.toThrow("Story creation is temporarily unavailable.");
  });

  it("BUI-2215 R1: an open-signup server with no subject refuses the story tools", async () => {
    const context = services(),
      client = await memoryClient(
        createHostedServer({ stories: context.stories, sessions: context.sessions, subject: undefined, ownerSubject: "", signup: "open" })
      ),
      result = await call(client, "list_stories");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/sign in/i);
  });

  it("BUI-2215 R2: a non-owner over the per-session story limit gets a message naming the limit and when it resets", async () => {
    const context = services(),
      client = await memoryClient(
        createHostedServer({ stories: context.stories, sessions: context.sessions, subject: "alice", ownerSubject: owner, signup: "open" })
      ),
      created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await call(client, "create_story", { ...createArgs, title: `Trip ${index}` });
      expect(result.isError, result.text).toBe(false);
      created.push(result.data?.id as string);
    }
    const oldest = await context.repository.findStory(created[0] as string),
      refused = await call(client, "create_story", { ...createArgs, title: "One too many" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/3 new stories in any 24 hours/);
    const resetsAt = new Date((oldest?.createdAt.getTime() ?? 0) + 24 * 60 * 60 * 1000).toISOString();
    expect(refused.text).toContain(resetsAt);
    expect(refused.data).toMatchObject({ limit: "stories", maximum: 3, windowHours: 24, resetsAt });
  });

  it("BUI-2215 R2: the story limit message names the rolling reset when the counted stories are not all listed", async () => {
    const context = services(),
      client = await memoryClient(
        createHostedServer({
          stories: context.stories,
          sessions: context.sessions,
          subject: "alice",
          ownerSubject: owner,
          signup: "open",
          removeObjects: async () => undefined,
        })
      );
    for (let index = 0; index < 3; index += 1) {
      const result = await call(client, "create_story", { ...createArgs, title: `Trip ${index}` });
      if (index === 0) expect((await call(client, "delete_story", { storyId: result.data?.id })).isError).toBe(false);
    }
    const refused = await call(client, "create_story", { ...createArgs, title: "One too many" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/3 new stories in any 24 hours/);
    expect(refused.text).toMatch(/24 hours after it was created/);
    expect(refused.data).toMatchObject({ limit: "stories", maximum: 3, windowHours: 24 });
    expect(refused.data?.resetsAt).toBeUndefined();
  });

  it("BUI-2215 R2: a non-owner over the per-session generation limit gets a message naming the limit and when it resets", async () => {
    const context = services(),
      client = await memoryClient(
        createHostedServer({ stories: context.stories, sessions: context.sessions, subject: "alice", ownerSubject: owner, signup: "open" })
      ),
      created = await call(client, "create_story", createArgs),
      storyId = created.data?.id as string;
    for (let index = 0; index < minStoryPhotos; index += 1)
      await context.repository.createUpload({
        id: `${storyId}-upload-${index}`,
        storyId,
        blobPath: `sources/${storyId}/${index}.jpg`,
        originalName: `${index}.jpg`,
        declaredType: "image/jpeg",
        status: "confirmed",
        createdAt: new Date(),
        confirmedAt: new Date(),
      });
    // A failed run may be generated again; the fourth start within 24 hours passes the per-session limit of three.
    for (let run = 0; run < 3; run += 1) {
      const started = await call(client, "start_generation", { storyId });
      expect(started.isError, started.text).toBe(false);
      const story = await context.repository.findStory(storyId);
      if (!story) throw new Error("story missing");
      await context.repository.saveStory({ ...story, status: "failed" }, story.version);
    }
    const refused = await call(client, "start_generation", { storyId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/3 generation runs in any 24 hours/);
    expect(refused.text).toMatch(/24 hours after it started/);
    expect(refused.data).toMatchObject({ limit: "generations", maximum: 3, windowHours: 24 });
  });

  it("BUI-2215 R2: other StoryService refusals keep their own message", async () => {
    const context = services(),
      client = await memoryClient(
        createHostedServer({ stories: context.stories, sessions: context.sessions, subject: "alice", ownerSubject: owner, signup: "open" })
      ),
      created = await call(client, "create_story", createArgs),
      refused = await call(client, "start_generation", { storyId: created.data?.id });
    expect(refused).toMatchObject({ isError: true, text: `Add at least ${minStoryPhotos} completed photos before generating a story.` });
  });
});

// @verifies DES-SITE-LANDING, DES-WEB-PRIVACY, ARCH-WEB-UI, REQ-WEB-02, REQ-WEB-07
describe("the site says who can sign in when signup is open (BUI-2215)", () => {
  it("BUI-2215 R3: the landing 'Use it in Claude' section names GitHub sign-in, what is stored, for how long, and delete_story", () => {
    const text = visibleText(claudeSection(renderToStaticMarkup(createElement(Landing, { signup: "open" }))));
    expect(text).toMatch(/Any GitHub account can sign in/);
    expect(text).not.toMatch(/invite-only/i);
    expect(text).toMatch(/source uploads expire after 24 hours and are deleted within 48 hours/i);
    expect(text).toMatch(/an unpublished draft is deleted after 30 days of inactivity/i);
    expect(text).toContain("delete_story");
    // The periods are the ones every upload page asks consent for.
    expect(uploadConsentText).toContain("source uploads expiring after 24 hours and being automatically deleted within 48 hours");
    expect(uploadConsentText).toContain("automatic deletion of an unpublished draft after 30 days of inactivity");
  });

  it("BUI-2215 R3: the home page reads WANDERPAGE_SIGNUP, and stays invite-only when it is unset", () => {
    vi.stubEnv("WANDERPAGE_SIGNUP", "open");
    expect(visibleText(claudeSection(renderToStaticMarkup(createElement(Home))))).toMatch(/Any GitHub account can sign in/);
    vi.stubEnv("WANDERPAGE_SIGNUP", "");
    const closed = visibleText(claudeSection(renderToStaticMarkup(createElement(Home))));
    expect(closed).toMatch(/invite-only/i);
    expect(closed).not.toMatch(/Any GitHub account/);
  });

  it("BUI-2215 R3: the privacy page names GitHub sign-in for any account, what is stored per user, and delete_story", () => {
    vi.stubEnv("WANDERPAGE_SIGNUP", "open");
    const text = visibleText(renderToStaticMarkup(createElement(PrivacyPage)));
    expect(text).toMatch(/Any GitHub account can sign in, through GitHub OAuth/);
    expect(text).not.toMatch(/Only the one owner can sign in/);
    expect(text).toMatch(/keyed hash of your GitHub login/);
    expect(text).toMatch(/Each account sees only its own stories/);
    expect(text).toMatch(/Source uploads expire after 24 hours and are deleted within 48 hours/);
    expect(text).toMatch(/An unpublished draft is deleted after 30 days of inactivity/);
    expect(text).toContain("delete_story");
  });

  it("BUI-2215 R3: with signup unset the privacy page keeps the owner-only wording", () => {
    vi.stubEnv("WANDERPAGE_SIGNUP", "");
    const text = visibleText(renderToStaticMarkup(createElement(PrivacyPage)));
    expect(text).toMatch(/Only the one owner can sign in/);
    expect(text).not.toMatch(/Any GitHub account can sign in/);
  });
});
