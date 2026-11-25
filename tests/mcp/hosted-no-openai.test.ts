import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { clearStoryServiceForTests } from "@/lib/web/runtime";
import { StoryService, type CurationMedia } from "@/lib/web/story-service";
import { hostedDependencies } from "@/app/api/mcp/_hosted/runtime";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

// The OpenAI client stub: every construction and every request through it is counted. The hosted flow must leave both at zero.
const openai = vi.hoisted(() => ({ constructed: 0, requests: 0 }));
vi.mock("openai", () => {
  class OpenAI {
    constructor() {
      openai.constructed += 1;
    }
    responses = {
      create: async () => {
        openai.requests += 1;
        throw new Error("The hosted server must not call OpenAI.");
      },
    };
    chat = { completions: { create: async () => this.responses.create() } };
  }
  return { default: OpenAI, OpenAI };
});

const owner = "owner-login",
  origin = "https://trips.example.com",
  savedKey = process.env.OPENAI_API_KEY;

let jpeg: Buffer;

/** A connection string neon() accepts, built from parts so no credential-like literal sits in the file. */
const databaseUrl = `postgresql://reader:${"x".repeat(8)}@db.test/wander`;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#7a8c99" } })
    .jpeg()
    .toBuffer();
});

beforeEach(() => {
  openai.constructed = 0;
  openai.requests = 0;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearStoryServiceForTests();
});

async function fixture() {
  const repository = new MemoryStoryRepository(),
    runs: string[] = [],
    media: CurationMedia = { read: async () => jpeg, write: async () => undefined },
    stories = new StoryService(
      repository,
      {
        start: async storyId => {
          runs.push(storyId);
          return { workflowRunId: "workflow" };
        },
      },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit: 25 }),
      async () => undefined,
      media
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner, publicOrigin: origin }),
    client = new Client({ name: "no-openai-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  async function story(photos = 6) {
    const created = await stories.createStory(await sessions.secretFor(owner), {
        title: "Lisbon in spring",
        peopleMode: "include",
        locationPrivacy: "hidden",
        termsVersion: currentDisclosureVersion,
        uploadConsentVersion: currentDisclosureVersion,
      }),
      ids: string[] = [];
    for (let index = 0; index < photos; index += 1) {
      const id = `${created.id.slice(0, 8)}-photo-${index}`;
      await repository.createUpload({
        id,
        storyId: created.id,
        blobPath: `sources/${created.id}/${id}.jpg`,
        originalName: `${index}.jpg`,
        declaredType: "image/jpeg",
        status: "confirmed",
        createdAt: new Date(Date.UTC(2026, 10, 24, 0, 0, index)),
        confirmedAt: new Date(),
      });
      ids.push(id);
    }
    return { story: created, ids };
  }

  return { repository, client, runs, story };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

const curation = (ids: string[]) => ({
  title: "Tiles and tram lines",
  intro: "Three days of steep streets, river light and late lunches.",
  namesNoPerson: true,
  photos: ids.slice(0, 3).map((photoId, index) => ({ photoId, caption: `Frame ${index + 1}: a tiled facade.`, containsPeople: false })),
});

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-03
describe("BUI-2206: hosted trip pages build from Claude's draft with no OpenAI call", () => {
  it("BUI-2206 R1: start_generation with a saved curation builds the page from it and never calls OpenAI", async () => {
    const context = await fixture(),
      { story, ids } = await context.story(),
      fetchSpy = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const saved = await call(context.client, "save_curation", { storyId: story.id, ...curation(ids) });
    expect(saved.isError, saved.text).toBe(false);

    const result = await call(context.client, "start_generation", { storyId: story.id });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, status: "draft", title: "Tiles and tram lines", photoCount: 3 });
    const stored = await context.repository.findStory(story.id);
    expect(stored?.manifest?.title).toBe("Tiles and tram lines");
    expect(stored?.manifest?.photos).toHaveLength(3);
    // No generation run was queued, so no workflow ran and no run counts toward a generation limit.
    expect(context.runs).toEqual([]);
    expect((await context.repository.listRuns(story.id)).filter(run => run.processorRevision !== "claude-v1")).toEqual([]);
    expect(openai).toEqual({ constructed: 0, requests: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Asking again leaves the draft as it was.
    const again = await call(context.client, "start_generation", { storyId: story.id });
    expect(again.data).toMatchObject({ id: story.id, status: "draft", version: result.data?.version });
  });

  it("BUI-2206 R1: start_generation on a published story reports it without queueing a run", async () => {
    const context = await fixture(),
      { story, ids } = await context.story();
    await call(context.client, "save_curation", { storyId: story.id, ...curation(ids) });
    expect((await call(context.client, "publish", { storyId: story.id })).isError).toBe(false);
    const result = await call(context.client, "start_generation", { storyId: story.id });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, status: "published" });
    expect(context.runs).toEqual([]);
    expect(openai).toEqual({ constructed: 0, requests: 0 });
  });

  it("BUI-2206 R2: start_generation with no saved curation tells the caller to call get_photos and save_curation first", async () => {
    const context = await fixture(),
      { story } = await context.story(),
      before = await context.repository.findStory(story.id);
    const result = await call(context.client, "start_generation", { storyId: story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no saved curation/);
    expect(result.text).toMatch(/get_photos/);
    expect(result.text).toMatch(/save_curation/);
    expect(result.text.indexOf("get_photos")).toBeLessThan(result.text.indexOf("save_curation"));
    expect(await context.repository.findStory(story.id)).toEqual(before);
    expect(await context.repository.listRuns(story.id)).toEqual([]);
    expect(context.runs).toEqual([]);
    expect(openai).toEqual({ constructed: 0, requests: 0 });
  });

  it("BUI-2206 R2: start_generation refuses a story whose curation save failed, and still queues no run", async () => {
    const context = await fixture(),
      { story, ids } = await context.story();
    const bad = await call(context.client, "save_curation", { storyId: story.id, ...curation(ids), namesNoPerson: false });
    expect(bad.isError).toBe(true);
    const result = await call(context.client, "start_generation", { storyId: story.id });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toMatch(/get_photos/);
    expect(context.runs).toEqual([]);
  });

  it("BUI-2206 R2: start_generation keeps refusing another owner's story with the owner-session message", async () => {
    const context = await fixture(),
      stranger = await new StoryService(
        context.repository,
        { start: async () => ({ workflowRunId: "workflow" }) },
        undefined,
        value => `hash:${value}`,
        () => ({ enabled: true, dailyLimit: 25 })
      ).createSessionWithStory(
        {
          title: "Someone else's trip",
          peopleMode: "include",
          locationPrivacy: "hidden",
          termsVersion: currentDisclosureVersion,
          uploadConsentVersion: currentDisclosureVersion,
        },
        "client"
      ),
      result = await call(context.client, "start_generation", { storyId: stranger.story.id });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^(This story belongs to another private session\.|Story not found\.)$/);
  });

  it("BUI-2206 R3: the hosted server starts and serves its tools with OPENAI_API_KEY unset", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("WANDERPAGE_SESSION_PEPPER", "p".repeat(40));
    const dependencies = hostedDependencies();
    expect(dependencies).not.toBeInstanceOf(Response);
    const context = await fixture(),
      listed = await call(context.client, "list_stories", {});
    expect(listed.isError, listed.text).toBe(false);
    const tools = (await context.client.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain("start_generation");
    expect(openai.constructed).toBe(0);
  });

  it("BUI-2206 R3: a missing OPENAI_API_KEY is not reported as a missing hosted setting", async () => {
    const missing = hostedDependencies({ DATABASE_URL: "postgres://db.test/wander" });
    expect(missing).toBeInstanceOf(Response);
    const body = await (missing as Response).text();
    expect(body).not.toContain("OPENAI_API_KEY");
  });
});
