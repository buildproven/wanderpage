import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import PrivacyPage from "@/app/privacy/page";
import { createHostedMcpHandler, hostedPrefix } from "@/app/api/mcp/_hosted/http";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { accountLimits, createHostedServer, type HostedServerOptions } from "@/app/api/mcp/_hosted/server";
import Landing from "@/components/Landing";
import { uploadConsentText } from "@/lib/consent";
import { minStoryPhotos } from "@/lib/web/limits";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";

const owner = "Owner-Login",
  origin = "https://trips.example.com",
  createArgs = { title: "Lisbon in spring", peopleMode: "exclude", locationPrivacy: "approximate" };

/** One story service and binding store shared by every account, as Neon is in production. */
function world() {
  const repository = new MemoryStoryRepository(),
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit: 25 }),
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

type World = ReturnType<typeof world>;

async function clientFor(
  { stories, sessions }: World,
  subject: string | undefined,
  signup: HostedServerOptions["signup"] = "open",
  ownerSubject = owner
) {
  const server = createHostedServer({
      stories,
      sessions,
      subject,
      ownerSubject,
      signup,
      publicOrigin: origin,
      removeObjects: async () => {},
    }),
    client = new Client({ name: "open-signup-test", version: "1.0.0" }),
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

async function createdId(client: Client, title: string) {
  const created = await call(client, "create_story", { ...createArgs, title });
  expect(created.isError, created.text).toBe(false);
  return created.data?.id as string;
}

const listedIds = async (client: Client) =>
  ((await call(client, "list_stories")).data?.stories as Array<{ id: string }>).map(story => story.id);

async function confirmUploads({ repository }: World, storyId: string) {
  for (let index = 0; index < minStoryPhotos; index += 1)
    await repository.createUpload({
      id: `${storyId}-upload-${index}`,
      storyId,
      blobPath: `sources/${storyId}/${index}.jpg`,
      originalName: `${index}.jpg`,
      declaredType: "image/jpeg",
      status: "confirmed",
      createdAt: new Date(),
      confirmedAt: new Date(),
    });
}

function visibleText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("open signup gives each GitHub account its own stories (BUI-2215 R1)", () => {
  it("BUI-2215 R1: two accounts each create a story, and neither sees the other's in list_stories or get_story", async () => {
    const shared = world(),
      ada = await clientFor(shared, "ada"),
      grace = await clientFor(shared, "grace"),
      adaStory = await createdId(ada, "Ada's trip"),
      graceStory = await createdId(grace, "Grace's trip");

    expect(await listedIds(ada)).toEqual([adaStory]);
    expect(await listedIds(grace)).toEqual([graceStory]);
    expect((await call(ada, "get_story", { storyId: adaStory })).data?.title).toBe("Ada's trip");
    for (const [client, other] of [
      [ada, graceStory],
      [grace, adaStory],
    ] as const) {
      const read = await call(client, "get_story", { storyId: other });
      expect(read.isError).toBe(true);
      expect(read.text).not.toMatch(/Ada's trip|Grace's trip/);
    }
    // Each account has its own owner session, so each has its own secret.
    expect(await shared.sessions.secretFor("ada")).not.toBe(await shared.sessions.secretFor("grace"));
  });

  it("BUI-2215 R1: the owner signed in through open signup (a lower-case login) keeps the stories of the owner session", async () => {
    const shared = world(),
      ownerMode = await clientFor(shared, owner, "owner"),
      kept = await createdId(ownerMode, "Before open signup"),
      openMode = await clientFor(shared, owner.toLowerCase(), "open");

    expect(await listedIds(openMode)).toEqual([kept]);
  });

  it("BUI-2215 R1: without open signup another account is still refused, and an open server refuses a token with no subject", async () => {
    const shared = world(),
      stranger = await clientFor(shared, "ada", "owner"),
      caseOnly = await clientFor(shared, owner.toLowerCase(), "owner"),
      noSubject = await clientFor(shared, undefined, "open");

    for (const client of [stranger, caseOnly]) {
      const listed = await call(client, "list_stories");
      expect(listed.isError).toBe(true);
      expect(listed.text).toMatch(/serves only its owner/);
    }
    const anonymous = await call(noSubject, "list_stories");
    expect(anonymous.isError).toBe(true);
    expect(anonymous.text).toMatch(/names no GitHub account/);
  });

  it("BUI-2215 R1: the default signup mode is read from WANDERPAGE_SIGNUP", async () => {
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "open");
    const shared = world(),
      server = createHostedServer({ stories: shared.stories, sessions: shared.sessions, subject: "ada", ownerSubject: owner }),
      client = new Client({ name: "open-signup-env-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    expect((await call(client, "list_stories")).data?.stories).toEqual([]);
  });
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("the hosted MCP entry with WANDERPAGE_SIGNUP=open (BUI-2215 R1)", () => {
  const issuer = "https://wander.test";
  let signingKey: CryptoKey, keys: JWTVerifyGetKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signingKey = pair.privateKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256" }] });
  });

  const mint = (subject: string) =>
    new SignJWT({ scope: "mcp", client_id: "client-1" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key", typ: "at+jwt" })
      .setIssuer(issuer)
      .setAudience(`${issuer}/api/mcp`)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);

  async function httpClient(handle: (request: Request) => Promise<Response>, subject: string) {
    const client = new Client({ name: "open-signup-http-test", version: "1.0.0" }),
      transport = new StreamableHTTPClientTransport(new URL(`${issuer}/api/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${await mint(subject)}` } },
        fetch: (input, init) => handle(new Request(input, init)),
      });
    await client.connect(transport);
    return client;
  }

  it("BUI-2215 R1: the entry, given WANDERPAGE_SIGNUP=open in its settings, serves two GitHub logins their own stories", async () => {
    const shared = world(),
      env = { WANDERPAGE_OAUTH_ISSUER: issuer, WANDERPAGE_OAUTH_JWKS_URL: `${issuer}/oauth/jwks`, WANDERPAGE_SIGNUP: "open" },
      handle = createHostedMcpHandler({
        env,
        keys,
        dependencies: () => ({ stories: shared.stories, sessions: shared.sessions, removeObjects: async () => {} }),
      }),
      ada = await httpClient(handle, "ada"),
      grace = await httpClient(handle, "grace"),
      adaStory = await createdId(ada, "Ada's trip"),
      graceStory = await createdId(grace, "Grace's trip");

    expect(await listedIds(ada)).toEqual([adaStory]);
    expect(await listedIds(grace)).toEqual([graceStory]);
    expect((await call(ada, "get_story", { storyId: graceStory })).isError).toBe(true);
  });
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-10
describe("a reached per-account limit names itself and its reset (BUI-2215 R2)", () => {
  it("BUI-2215 R2: a non-owner over the story limit gets a message naming the limit and when it resets", async () => {
    const shared = world(),
      at = new Date("2026-11-24T12:00:00.000Z"),
      server = createHostedServer({
        stories: shared.stories,
        sessions: shared.sessions,
        subject: "ada",
        ownerSubject: owner,
        signup: "open",
        now: () => at,
      }),
      ada = new Client({ name: "open-signup-story-limit-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), ada.connect(clientSide)]);
    for (let index = 0; index < accountLimits.storiesPerDay; index += 1) await createdId(ada, `Trip ${index}`);
    const refused = await call(ada, "create_story", { ...createArgs, title: "One too many" }),
      resetsAt = "2026-11-25T12:00:00.000Z";

    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/story limit/);
    expect(refused.text).toContain(`${accountLimits.storiesPerDay} stories in any 24 hours`);
    expect(refused.text).toMatch(/The limit resets/);
    expect(refused.text).toContain(resetsAt);
    expect(refused.data).toEqual({ limit: "stories", perDay: accountLimits.storiesPerDay, resetsAt });
    // Another account is not held back by Ada's limit.
    expect((await call(await clientFor(shared, "grace"), "create_story", createArgs)).isError).toBe(false);
  });

  it("BUI-2215 R2: a non-owner over the generation limit gets a message naming the limit and when it resets", async () => {
    const shared = world(),
      at = new Date("2026-11-24T12:00:00.000Z"),
      server = createHostedServer({
        stories: shared.stories,
        sessions: shared.sessions,
        subject: "ada",
        ownerSubject: owner,
        signup: "open",
        now: () => at,
      }),
      ada = new Client({ name: "open-signup-generation-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), ada.connect(clientSide)]);
    const secret = await shared.sessions.secretFor("ada"),
      session = await shared.stories.requireSession(secret);
    for (let index = 0; index <= accountLimits.generationsPerDay; index += 1) {
      const story = {
        id: crypto.randomUUID(),
        ownerSessionId: session.id,
        admissionKey: shared.sessions.admissionKeyFor("ada"),
        status: "uploading" as const,
        title: `Trip ${index}`,
        peopleMode: "exclude" as const,
        locationPrivacy: "approximate" as const,
        processorRevision: "web-v1",
        sourceExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 0,
      };
      await shared.repository.createStory(story);
      await confirmUploads(shared, story.id);
      const started = await call(ada, "start_generation", { storyId: story.id });
      if (index < accountLimits.generationsPerDay) {
        expect(started.isError, started.text).toBe(false);
        continue;
      }
      expect(started.isError).toBe(true);
      expect(started.text).toMatch(/generation limit/);
      expect(started.text).toContain(`${accountLimits.generationsPerDay} generations in any 24 hours`);
      expect(started.text).toMatch(/The limit resets/);
      expect(started.text).toContain("2026-11-25T12:00:00.000Z");
      expect(started.data).toMatchObject({ limit: "generations", resetsAt: "2026-11-25T12:00:00.000Z" });
    }
  });
});

// @verifies DES-SITE-LANDING, DES-WEB-PRIVACY, ARCH-WEB-UI, REQ-WEB-02
describe("the site says who can sign in when signup is open (BUI-2215 R3)", () => {
  it("BUI-2215 R3: the landing 'Use it in Claude' section names GitHub sign-in, what is kept and delete_story when signup is open", () => {
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "open");
    const html = renderToStaticMarkup(Home()),
      section = /<section[^>]*aria-labelledby="claude-title"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "",
      text = visibleText(section);

    expect(text).toMatch(/you can sign in with any GitHub account/);
    expect(text).not.toMatch(/invite-only/i);
    expect(text).toContain("delete_story");
    // The periods the upload consent states.
    expect(uploadConsentText).toContain("deleted within 48 hours");
    expect(uploadConsentText).toContain("30 days of inactivity");
    expect(text).toMatch(
      /source photos expire after 24 hours and are deleted within 48 hours, an unpublished draft is deleted after 30 days of inactivity/
    );
  });

  it("BUI-2215 R3: the Landing component reads WANDERPAGE_SIGNUP itself when no mode is passed", () => {
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, " Open ");
    const text = visibleText(renderToStaticMarkup(createElement(Landing)));
    expect(text).toMatch(/you can sign in with any GitHub account/);
    expect(text).toContain("delete_story");
    // A passed mode wins over the setting.
    expect(visibleText(renderToStaticMarkup(createElement(Landing, { openSignup: false })))).toMatch(/invite-only/i);
  });

  it("BUI-2215 R3: the landing stays invite-only when signup is not open", () => {
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "owner");
    expect(visibleText(renderToStaticMarkup(Home()))).toMatch(/invite-only/i);
    expect(visibleText(renderToStaticMarkup(createElement(Landing)))).not.toMatch(/any GitHub account/i);
  });

  it("BUI-2215 R3: the privacy page names GitHub sign-in for any account, what each account stores, its limits and delete_story", () => {
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "open");
    const text = visibleText(renderToStaticMarkup(PrivacyPage()));

    expect(text).toMatch(/you can sign in with any GitHub account, through GitHub OAuth/);
    expect(text).not.toMatch(/Only the one owner can sign in/);
    expect(text).toMatch(/For each account, Wanderpage stores its stories/);
    expect(text).toMatch(/Source uploads expire after 24 hours and are deleted within 48 hours/);
    expect(text).toMatch(/An unpublished draft is deleted after 30 days of inactivity/);
    expect(text).toContain(
      `create ${accountLimits.storiesPerDay} stories and start ${accountLimits.generationsPerDay} generations in any 24 hours`
    );
    expect(text).toContain("delete_story");
  });

  it("BUI-2215 R3: the privacy page keeps the owner-only rule when signup is not open", () => {
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "");
    const text = visibleText(renderToStaticMarkup(PrivacyPage()));
    expect(text).toMatch(/Only the one owner can sign in/);
    expect(text).not.toMatch(/any GitHub account/i);
  });
});
