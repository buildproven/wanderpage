import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@/lib/ai/provider";
import { createServer } from "@/mcp/server";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "",
  photos = "",
  bare = "",
  sites = 0;
const saved = { key: process.env.OPENAI_API_KEY };
const offline = {
  aiProvider: new MockAIProvider(),
  inferDestinations: async () => [],
  enrichDestination: async () => ({ introduction: "", facts: [], sources: [] }),
};

beforeAll(async () => {
  workspace = await createTempWorkspace("mcp");
  photos = await createPhotoFolder(workspace, { count: 20 });
  bare = await createPhotoFolder(join(workspace, "nogps"), { count: 4, gps: false });
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});
beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.key;
});

async function connect(extra: { withProvider?: boolean } = {}) {
  const root = join(workspace, `site-${++sites}`);
  await mkdir(root, { recursive: true });
  const server = createServer({ root, dependencies: extra.withProvider === false ? { ...offline, aiProvider: undefined } : offline });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server, root };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return { isError: response.isError === true, text, data: response.isError ? undefined : JSON.parse(text) };
};

// @verifies DES-MCP-TOOLS, ARCH-MCP
describe("local MCP server", () => {
  // @verifies REQ-MCP-1
  it("lists the four tools, each with a strict input schema", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["create_draft", "get_draft", "inspect_photos", "list_drafts"]);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  });

  // @verifies REQ-MCP-1
  it("rejects unknown and missing arguments", async () => {
    const { client } = await connect();
    const extra = await call(client, "inspect_photos", { folder: photos, surprise: true }).catch(error => ({
      isError: true,
      text: String(error),
    }));
    expect(extra.isError).toBe(true);
    const missing = await call(client, "get_draft", {}).catch(error => ({ isError: true, text: String(error) }));
    expect(missing.isError).toBe(true);
  });

  // @verifies REQ-MCP-2
  it("inspects a folder for photo count, GPS, and dates", async () => {
    const { client } = await connect();
    const { data } = await call(client, "inspect_photos", { folder: photos });
    expect(data).toMatchObject({ supportedPhotos: 22, hasGps: true, hasDates: true });
    expect(data.photosWithGps).toBeGreaterThan(0);
    expect(data.photosWithDates).toBeGreaterThan(0);
  });

  // @verifies REQ-MCP-2
  it("reports no GPS for a folder whose photos carry none, and a tool error for a missing folder", async () => {
    const { client } = await connect();
    const { data } = await call(client, "inspect_photos", { folder: bare });
    expect(data).toMatchObject({ hasGps: false, photosWithGps: 0 });
    const missing = await call(client, "inspect_photos", { folder: join(workspace, "missing") });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not found/i);
  });

  // @verifies REQ-MCP-3
  it("creates a private draft and states the count actually selected", async () => {
    const { client, root } = await connect();
    const { data } = await call(client, "create_draft", {
      folder: photos,
      people: "include",
      locationPrivacy: "approximate",
      title: "MCP Coast",
      maxPhotos: 2,
    });
    expect(data.slug).toBe("mcp-coast");
    expect(data.summary).toMatchObject({ title: "MCP Coast", published: false, requestedMaxPhotos: 2 });
    // targetCount never allows fewer than 18 photos (lib/selection/select.ts), so a maximum of 2 is exceeded;
    // this fixture has four distinct compositions, so four are selected, and the result says so.
    const stored = JSON.parse(await readFile(join(root, "data/trips/mcp-coast.json"), "utf8"));
    expect(data.summary.selectedPhotos).toBe(stored.photos.length);
    expect(data.summary.selectedPhotos).toBeGreaterThan(2);
    expect(data.summary.note).toMatch(/at most 2.*at least 18/);
    expect(stored.published).toBe(false);
  });

  // @verifies REQ-MCP-3
  it("refuses people exclusion without a vision provider", async () => {
    const { client } = await connect({ withProvider: false });
    const refused = await call(client, "create_draft", { folder: photos, people: "exclude", locationPrivacy: "hidden" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/OPENAI_API_KEY/);
    expect((await call(client, "list_drafts", {})).data.drafts).toEqual([]);
  });

  // @verifies REQ-MCP-3
  it("rejects invalid people, privacy, and photo-count values", async () => {
    const { client } = await connect();
    for (const args of [
      { folder: photos, people: "maybe", locationPrivacy: "hidden" },
      { folder: photos, people: "include", locationPrivacy: "exact" },
      { folder: photos, people: "include", locationPrivacy: "hidden", maxPhotos: 0 },
      { folder: photos, people: "include", locationPrivacy: "hidden", maxPhotos: 1.5 },
    ]) {
      const outcome = await call(client, "create_draft", args).catch(error => ({ isError: true, text: String(error) }));
      expect(outcome.isError).toBe(true);
    }
  });

  // @verifies REQ-MCP-3
  it("returns a tool error for a missing photo folder", async () => {
    const { client } = await connect();
    const outcome = await call(client, "create_draft", {
      folder: join(workspace, "missing"),
      people: "include",
      locationPrivacy: "hidden",
    });
    expect(outcome.isError).toBe(true);
  });

  // @verifies REQ-MCP-4
  it("returns the manifest with the reason each photo was selected, and lists drafts with their published state", async () => {
    const { client } = await connect();
    const created = (await call(client, "create_draft", { folder: photos, people: "include", locationPrivacy: "hidden", title: "Reasons" }))
      .data;
    const { data } = await call(client, "get_draft", { slug: created.slug });
    expect(data.manifest.title).toBe("Reasons");
    expect(data.photos).toHaveLength(data.manifest.photos.length);
    for (const photo of data.photos) expect(photo.reason).toMatch(/^Selected:/);
    const listed = await call(client, "list_drafts", {});
    expect(listed.data.drafts).toContainEqual({ slug: created.slug, title: "Reasons", published: false });
  });

  // @verifies REQ-MCP-4
  it("rejects a slug outside the grammar and reports a missing draft", async () => {
    const { client } = await connect();
    expect((await call(client, "get_draft", { slug: "../trip.demo" })).isError).toBe(true);
    const missing = await call(client, "get_draft", { slug: "no-such-draft" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/no-such-draft/);
  });

  // @verifies REQ-MCP-4
  it("falls back to a null reason for a draft written without a recorded selection", async () => {
    const { client, root } = await connect();
    const created = (await call(client, "create_draft", { folder: photos, people: "include", locationPrivacy: "hidden", title: "Legacy" }))
      .data;
    await writeFile(join(root, ".trip-output/selection.json"), JSON.stringify({ selected: [], rejected: [], reasons: {} }));
    await writeFile(join(root, ".trip-output/reasons", `${created.slug}.json`), "not json");
    const { data } = await call(client, "get_draft", { slug: created.slug });
    for (const photo of data.photos) expect(photo.reason).toBeNull();
  });

  // @verifies REQ-MCP-4
  it("uses the latest run's selection for a draft that has no per-draft record", async () => {
    const { client, root } = await connect();
    const created = (await call(client, "create_draft", { folder: photos, people: "include", locationPrivacy: "hidden", title: "Studio" }))
      .data;
    await rm(join(root, ".trip-output/reasons"), { recursive: true });
    const { data } = await call(client, "get_draft", { slug: created.slug });
    for (const photo of data.photos) expect(photo.reason).toMatch(/^Selected:/);
  });

  // @verifies REQ-MCP-2, REQ-MCP-3
  it("handles a folder with no photos and a photo that cannot be read", async () => {
    const { client } = await connect();
    const empty = join(workspace, "empty-photos");
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, "broken.jpg"), "not an image");
    expect((await call(client, "inspect_photos", { folder: empty })).data).toMatchObject({
      supportedPhotos: 1,
      photosWithGps: 0,
      photosWithDates: 0,
      hasGps: false,
      hasDates: false,
    });
    const created = await call(client, "create_draft", { folder: empty, people: "include", locationPrivacy: "hidden" });
    expect(created.isError).toBe(true);
    const nothing = join(workspace, "no-files");
    await mkdir(nothing, { recursive: true });
    expect((await call(client, "create_draft", { folder: nothing, people: "include", locationPrivacy: "hidden" })).text).toMatch(
      /No supported/
    );
  });

  // @verifies REQ-MCP-4
  it("lists no drafts in an empty workspace", async () => {
    const { client } = await connect();
    expect((await call(client, "list_drafts", {})).data).toEqual({ drafts: [] });
  });
});
