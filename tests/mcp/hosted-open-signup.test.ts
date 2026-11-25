import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Landing from "@/components/Landing";
import PrivacyPage from "@/app/privacy/page";
import { hostedPrefix } from "@/app/api/mcp/_hosted/http";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer, type HostedServerOptions } from "@/app/api/mcp/_hosted/server";
import { minStoryPhotos } from "@/lib/web/limits";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";

const owner = "owner-login",
  alice = "alice-login",
  bob = "bob-login",
  storyArgs = { title: "Lisbon by tram", peopleMode: "exclude", locationPrivacy: "approximate" };

/** One shared story service and owner-session store; each `connect` is a request signed in as one subject. */
function world(start = new Date("2026-11-24T09:00:00.000Z")) {
  let now = start;
  const repository = new MemoryStoryRepository(),
    clock = () => now,
    stories = new StoryService(
      repository,
      { start: async (storyId: string) => ({ workflowRunId: `workflow-${storyId}` }) },
      clock,
      value => `hash:${value}`,
      // Public creation off: every MCP account gets a session of kind `owner`, which the owner switch admits.
      () => ({ enabled: false, ownerEnabled: true, dailyLimit: 25 }),
      async () => undefined
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
      now: clock,
    });
  async function connect(subject: string | undefined, options: Partial<HostedServerOptions> = { signup: "open" }) {
    const server = createHostedServer({
        stories,
        sessions,
        subject,
        ownerSubject: owner,
        publicOrigin: "https://trips.example.com",
        removeObjects: async () => undefined,
        now: clock,
        ...options,
      }),
      client = new Client({ name: "open-signup-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return {
        isError: response.isError === true,
        text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
        data: response.structuredContent as Record<string, unknown> | undefined,
      };
    };
  }
  return {
    repository,
    stories,
    sessions,
    connect,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const ids = (result: { data?: Record<string, unknown> }) => ((result.data?.stories ?? []) as Array<{ id: string }>).map(story => story.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01
describe("BUI-2215 R1: open signup gives each GitHub subject its own owner session", () => {
  it("BUI-2215 R1: two non-owner subjects each create a story and neither sees the other's in list_stories or get_story", async () => {
    const { connect, repository } = world(),
      asAlice = await connect(alice),
      asBob = await connect(bob),
      aliceStory = await asAlice("create_story", { ...storyArgs, title: "Alice in Porto" }),
      bobStory = await asBob("create_story", { ...storyArgs, title: "Bob in Seville" });
    expect(aliceStory.isError, aliceStory.text).toBe(false);
    expect(bobStory.isError, bobStory.text).toBe(false);
    const aliceId = String(aliceStory.data?.id),
      bobId = String(bobStory.data?.id);

    expect(ids(await asAlice("list_stories"))).toEqual([aliceId]);
    expect(ids(await asBob("list_stories"))).toEqual([bobId]);
    expect((await asAlice("get_story", { storyId: aliceId })).data?.title).toBe("Alice in Porto");
    const crossRead = await asAlice("get_story", { storyId: bobId }),
      crossBack = await asBob("get_story", { storyId: aliceId });
    expect(crossRead.isError).toBe(true);
    expect(crossRead.text).not.toContain("Bob in Seville");
    expect(crossBack.isError).toBe(true);
    expect(crossBack.text).not.toContain("Alice in Porto");

    // Each subject has its own owner session and its own admission key, never the owner's.
    const [aliceRow, bobRow] = [await repository.findStory(aliceId), await repository.findStory(bobId)];
    expect(aliceRow?.ownerSessionId).not.toBe(bobRow?.ownerSessionId);
    expect(aliceRow?.admissionKey).not.toBe(bobRow?.admissionKey);
  });

  it("BUI-2215 R1: open signup needs no owner subject, and a token with no subject is refused", async () => {
    const { connect } = world(),
      asAlice = await connect(alice, { signup: "open", ownerSubject: "" }),
      created = await asAlice("create_story", storyArgs);
    expect(created.isError, created.text).toBe(false);
    expect(ids(await asAlice("list_stories"))).toEqual([created.data?.id]);

    const anonymous = await connect(undefined),
      refused = await anonymous("list_stories");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/names no owner/);
  });

  it("BUI-2215 R1: owner signup still serves only the owner subject", async () => {
    const { connect } = world(),
      asAlice = await connect(alice, { signup: "owner" }),
      refused = await asAlice("list_stories");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/serves only its owner/);
    expect((await (await connect(owner, { signup: "owner" }))("list_stories")).isError).toBe(false);
  });

  it(`BUI-2215 R1: the mode defaults to ${hostedPrefix}_SIGNUP, and a value that is not open keeps owner-only signup`, async () => {
    const { connect } = world();
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "open");
    expect((await (await connect(alice, {}))("list_stories")).isError).toBe(false);
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "everyone");
    expect((await (await connect(alice, {}))("list_stories")).text).toMatch(/serves only its owner/);
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "");
    expect((await (await connect(alice, {}))("list_stories")).text).toMatch(/serves only its owner/);
  });
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-10
describe("BUI-2215 R2: a non-owner over a per-account limit gets a message that names the limit and its reset", () => {
  it("BUI-2215 R2: create_story over the story limit names the limit and the time it resets", async () => {
    const { connect, advance } = world(),
      asAlice = await connect(alice),
      first = await asAlice("create_story", { ...storyArgs, title: "Day one" });
    expect(first.isError, first.text).toBe(false);
    advance(60 * 60 * 1000);
    for (const title of ["Day two", "Day three"]) expect((await asAlice("create_story", { ...storyArgs, title })).isError).toBe(false);
    advance(60 * 60 * 1000);
    const refused = await asAlice("create_story", { ...storyArgs, title: "One too many" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/create_story refused/);
    expect(refused.text).toMatch(/3 stories in 24 hours/);
    // The oldest story in the window was created at 09:00, so a slot opens by 09:00 the next day.
    expect(refused.text).toContain("2026-11-25T09:00:00.000Z");
    expect(refused.data).toMatchObject({ limit: "stories", perAccount: 3, windowHours: 24, resetsBy: "2026-11-25T09:00:00.000Z" });

    // Another subject is not held back by Alice's limit.
    expect((await (await connect(bob))("create_story", storyArgs)).isError).toBe(false);
    advance(22 * 60 * 60 * 1000 + 1);
    expect((await asAlice("create_story", { ...storyArgs, title: "After the reset" })).isError).toBe(false);
  });

  it("BUI-2215 R2: when every story of the window is deleted, the story-limit refusal still says when it resets", async () => {
    const { connect } = world(),
      asAlice = await connect(alice);
    for (const title of ["One", "Two", "Three"]) {
      const created = await asAlice("create_story", { ...storyArgs, title });
      expect(created.isError, created.text).toBe(false);
      expect((await asAlice("delete_story", { storyId: created.data?.id })).isError).toBe(false);
    }
    const refused = await asAlice("create_story", storyArgs);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/3 stories in 24 hours/);
    expect(refused.text).toMatch(/try again 24 hours after the oldest one/);
    expect(refused.data).toMatchObject({ limit: "stories", resetsBy: null });
  });

  it("BUI-2215 R2: start_generation over the generation limit names the limit and when it resets", async () => {
    const { connect, repository } = world(),
      asAlice = await connect(alice),
      created = await asAlice("create_story", storyArgs),
      storyId = String(created.data?.id);
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = await asAlice("start_generation", { storyId });
      expect(started.isError, started.text).toBe(false);
      const story = await repository.findStory(storyId);
      if (!story) throw new Error("The story is missing.");
      await repository.saveStory({ ...story, status: "failed", activeRunId: undefined }, story.version);
    }
    const refused = await asAlice("start_generation", { storyId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/start_generation refused/);
    expect(refused.text).toMatch(/3 generations in 24 hours/);
    expect(refused.text).toMatch(/24 hours after it started/);
    expect(refused.data).toMatchObject({ limit: "generations", perAccount: 3, windowHours: 24 });
  });
});

function visibleText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// @verifies DES-SITE-LANDING, DES-WEB-PRIVACY, ARCH-WEB-UI, REQ-WEB-02, REQ-WEB-07
describe("BUI-2215 R3: the site says who can sign in, what is kept, and how to delete a story", () => {
  const claudeSection = (html: string) =>
    visibleText(/<section[^>]*aria-labelledby="claude-title"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "");

  it("BUI-2215 R3: with open signup the landing 'Use it in Claude' section names GitHub sign-in, retention and delete_story", () => {
    const text = claudeSection(renderToStaticMarkup(createElement(Landing, { signup: "open" })));
    expect(text).toMatch(/Any GitHub account can sign in/);
    expect(text).not.toMatch(/invite-only/);
    expect(text).toMatch(/24 hours/);
    expect(text).toMatch(/48 hours/);
    expect(text).toMatch(/30 days/);
    expect(text).toContain("delete_story");
  });

  it("BUI-2215 R3: with owner signup the landing still says sign-in is invite-only", () => {
    const text = claudeSection(renderToStaticMarkup(createElement(Landing)));
    expect(text).toMatch(/invite-only/);
    expect(text).not.toMatch(/Any GitHub account/);
  });

  it(`BUI-2215 R3: with ${hostedPrefix}_SIGNUP=open the privacy page names GitHub sign-in for any account, retention and delete_story`, () => {
    vi.stubEnv(`${hostedPrefix}_SIGNUP`, "open");
    const text = visibleText(renderToStaticMarkup(createElement(PrivacyPage)));
    expect(text).toMatch(/Any GitHub account can sign in/);
    expect(text).not.toMatch(/Only the one owner can sign in/);
    expect(text).toMatch(/keyed hash of your GitHub login/);
    expect(text).toMatch(/expire after 24 hours and are deleted within 48 hours/);
    expect(text).toMatch(/after 30 days of inactivity/);
    expect(text).toContain("delete_story");
  });

  it("BUI-2215 R3: without open signup the privacy page keeps the one-owner sign-in", () => {
    const text = visibleText(renderToStaticMarkup(createElement(PrivacyPage)));
    expect(text).toMatch(/Only the one owner can sign in/);
    expect(text).not.toMatch(/Any GitHub account/);
  });
});
