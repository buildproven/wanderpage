import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { minStoryPhotos } from "@/lib/web/limits";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { clearStoryServiceForTests } from "@/lib/web/runtime";
import { curationRevision, StoryService, type CurationMedia, type GenerationPolicy } from "@/lib/web/story-service";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { hostedDependencies } from "@/app/api/mcp/_hosted/runtime";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

// The OpenAI client stub: hosted generation reaches OpenAI only through `new OpenAI(...)` (lib/ai/provider.ts), so a page built with no
// OpenAI request never constructs it and never calls it.
const openai = vi.hoisted(() => ({ constructed: vi.fn(), requested: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    constructor(...options: unknown[]) {
      openai.constructed(...options);
    }
    responses = { parse: openai.requested, create: openai.requested };
    chat = { completions: { create: openai.requested, parse: openai.requested } };
  },
}));

const owner = "owner-login",
  origin = "https://trips.example.com",
  storyArgs = { title: "Kyoto in autumn", peopleMode: "exclude", locationPrivacy: "approximate" };

let photo: Buffer;

beforeAll(async () => {
  photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#6b8fa3" } })
    .jpeg()
    .toBuffer();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  openai.constructed.mockClear();
  openai.requested.mockClear();
  clearStoryServiceForTests();
});

async function fixture(policy: GenerationPolicy = { enabled: true, dailyLimit: 25 }) {
  const repository = new MemoryStoryRepository(),
    started: string[] = [],
    written: string[] = [],
    // Every confirmed upload reads as the same small JPEG, so save_curation can build a page from any of them.
    media: CurationMedia = {
      read: async () => photo,
      write: async pathname => {
        written.push(pathname);
      },
    },
    stories = new StoryService(
      repository,
      {
        // The paid generation runner: production starts the workflow that calls OpenAI (lib/web/processor.ts runTrip).
        start: async storyId => {
          started.push(storyId);
          return { workflowRunId: "workflow" };
        },
      },
      undefined,
      value => `hash:${value}`,
      () => policy,
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
    client = new Client({ name: "hosted-no-openai-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { repository, stories, sessions, client, policy, started, written };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

/** A new owner story with `count` confirmed uploads, IDs `<storyId>-upload-<n>`. */
async function uploadedStory({ client, repository }: Fixture, count = minStoryPhotos) {
  const created = await call(client, "create_story", storyArgs);
  expect(created.isError, created.text).toBe(false);
  const storyId = created.data?.id as string;
  for (let index = 0; index < count; index += 1)
    await repository.createUpload({
      id: `${storyId}-upload-${index}`,
      storyId,
      blobPath: `sources/${storyId}/${index}.jpg`,
      originalName: `${index}.jpg`,
      declaredType: "image/jpeg",
      status: "confirmed",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
      confirmedAt: new Date(),
    });
  return storyId;
}

const curation = (storyId: string) => ({
  storyId,
  title: "Kyoto in autumn",
  intro: "Maple light along the river.",
  namesNoPerson: true,
  photos: [0, 1, 2].map(index => ({
    photoId: `${storyId}-upload-${index}`,
    caption: "A temple roof under red leaves.",
    containsPeople: false,
  })),
});

const noCuration = /^start_generation refused: "Kyoto in autumn" has no saved curation\. Call get_photos .* then save_curation/;

function expectNoOpenAI(context: Fixture) {
  expect(openai.constructed).not.toHaveBeenCalled();
  expect(openai.requested).not.toHaveBeenCalled();
  expect(context.started).toEqual([]);
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-04
describe("hosted trip pages build from Claude's draft with no OpenAI call (BUI-2206)", () => {
  it("BUI-2206 R1: start_generation with a saved curation returns the page built from it and makes no OpenAI request", async () => {
    vi.stubEnv("OPENAI_API_KEY", ["sk", "test", "configured"].join("-"));
    const context = await fixture(),
      storyId = await uploadedStory(context);
    const saved = await call(context.client, "save_curation", curation(storyId));
    expect(saved.isError, saved.text).toBe(false);
    const result = await call(context.client, "start_generation", { storyId });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ id: storyId, status: "draft", photoCount: 3 });
    const story = await context.repository.findStory(storyId);
    expect(story?.manifest).toMatchObject({ title: "Kyoto in autumn", opening: "Maple light along the river." });
    expect(story?.manifest?.photos.map(entry => entry.id)).toEqual([0, 1, 2].map(index => `${storyId}-upload-${index}`));
    expect(story?.manifest?.photos.every(entry => entry.caption === "A temple roof under red leaves.")).toBe(true);
    // The only run is the curation build: start_generation queued nothing and never reached the OpenAI client or the paid runner.
    expect((await context.repository.listRuns(storyId)).map(run => run.processorRevision)).toEqual([curationRevision]);
    expectNoOpenAI(context);
  });

  it("BUI-2206 R1: start_generation reports a published curated story as it is, and has no generation limit", async () => {
    const context = await fixture({ enabled: true, dailyLimit: 1 }),
      storyId = await uploadedStory(context);
    expect((await call(context.client, "save_curation", curation(storyId))).isError).toBe(false);
    const published = await call(context.client, "publish", { storyId });
    expect(published.isError, published.text).toBe(false);
    // More calls than any generation limit: none is refused and none starts a run.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await call(context.client, "start_generation", { storyId });
      expect(result.isError, result.text).toBe(false);
      expect(result.data).toMatchObject({ id: storyId, status: "published", published: true, photoCount: 3 });
    }
    expect(await context.repository.listRuns(storyId)).toHaveLength(1);
    expectNoOpenAI(context);
  });

  it("BUI-2206 R1: start_generation reports a curation build that save_curation is still running", async () => {
    const context = await fixture(),
      storyId = await uploadedStory(context),
      story = await context.repository.findStory(storyId);
    if (!story) throw new Error("story missing");
    // The state save_curation leaves while it resizes the chosen photos: a queued curation run.
    await context.repository.queueRun(
      { ...story, processorRevision: curationRevision },
      {
        id: "11111111-1111-4111-8111-111111111111",
        storyId,
        processorRevision: curationRevision,
        admissionKey: "client",
        admittedAt: new Date(),
        status: "queued",
        stage: "queued",
        progress: 0,
        attempts: 0,
        sourceUploadIds: [],
        updatedAt: new Date(),
      },
      { sessionStarts: 99, clientStarts: 99, globalStarts: 99, since: new Date(), now: new Date(), minPhotos: 1 }
    );
    const result = await call(context.client, "start_generation", { storyId });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ id: storyId, status: "queued" });
    // Once the build claims its run, the story is processing and is still reported, not refused.
    await context.repository.claimRun(storyId, "11111111-1111-4111-8111-111111111111", new Date());
    const building = await call(context.client, "start_generation", { storyId });
    expect(building.isError, building.text).toBe(false);
    expect(building.data).toMatchObject({ id: storyId, status: "processing" });
    expect(await context.repository.listRuns(storyId)).toHaveLength(1);
    expectNoOpenAI(context);
  });

  it("BUI-2206 R2: start_generation with no saved curation refuses, names get_photos and save_curation, and queues nothing", async () => {
    const context = await fixture(),
      storyId = await uploadedStory(context);
    const result = await call(context.client, "start_generation", { storyId });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(noCuration);
    expect(result.data).toMatchObject({ storyId, status: "uploading" });
    expect(await context.repository.findStory(storyId)).toMatchObject({ status: "uploading" });
    expect(await context.repository.listRuns(storyId)).toEqual([]);
    expectNoOpenAI(context);
  });

  it("BUI-2206 R2: a story whose curation build failed has no saved curation and is refused the same way", async () => {
    const context = await fixture(),
      storyId = await uploadedStory(context);
    // The build fails as it stores the page: the story is failed and keeps no page.
    vi.spyOn(context.repository, "completeRun").mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await call(context.client, "save_curation", curation(storyId))).isError).toBe(true);
    expect(await context.repository.findStory(storyId)).toMatchObject({ status: "failed", processorRevision: curationRevision });
    const result = await call(context.client, "start_generation", { storyId });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(noCuration);
    expect(result.data).toMatchObject({ storyId, status: "failed" });
    expectNoOpenAI(context);
  });

  it("BUI-2206 R2: a draft the old OpenAI generation wrote is not a saved curation and is refused", async () => {
    const context = await fixture(),
      storyId = await uploadedStory(context);
    expect((await call(context.client, "save_curation", curation(storyId))).isError).toBe(false);
    const draft = await context.repository.findStory(storyId);
    if (!draft) throw new Error("story missing");
    // Saved data from before BUI-2205: a draft whose page the paid processor revision built.
    await context.repository.saveStory({ ...draft, processorRevision: "web-v1" }, draft.version);
    const result = await call(context.client, "start_generation", { storyId });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(noCuration);
    expectNoOpenAI(context);
  });

  it("BUI-2206 R3: the hosted server starts and builds a page with OPENAI_API_KEY unset", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://wander:local@db.test/wander");
    vi.stubEnv("WANDERPAGE_SESSION_PEPPER", "p".repeat(40));
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const dependencies = hostedDependencies({
      DATABASE_URL: process.env.DATABASE_URL,
      WANDERPAGE_SESSION_PEPPER: process.env.WANDERPAGE_SESSION_PEPPER,
    });
    expect(dependencies).not.toBeInstanceOf(Response);
    if (dependencies instanceof Response) throw new Error(await dependencies.text());
    const server = createHostedServer({ ...dependencies, subject: owner, ownerSubject: owner, publicOrigin: origin }),
      client = new Client({ name: "hosted-no-openai-start", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(["create_story", "get_photos", "save_curation", "start_generation"])
    );
    await client.close();

    // With the key still unset, the whole hosted flow ends in a built page.
    const context = await fixture(),
      storyId = await uploadedStory(context);
    expect((await call(context.client, "save_curation", curation(storyId))).isError).toBe(false);
    const result = await call(context.client, "start_generation", { storyId });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ id: storyId, status: "draft", photoCount: 3 });
    expectNoOpenAI(context);
  });
});
