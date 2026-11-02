import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@/lib/ai/provider";
import { runTrip } from "@/lib/pipeline/run";
import { deleteTrip } from "@/lib/trips/publish";
import { createServer } from "@/mcp/server";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "",
  first = "",
  second = "";
const saved = { key: process.env.OPENAI_API_KEY };
const offline = {
  aiProvider: new MockAIProvider(),
  inferDestinations: async () => [],
  enrichDestination: async () => ({ introduction: "", facts: [], sources: [] }),
};

beforeAll(async () => {
  workspace = await createTempWorkspace("mcp-reasons");
  first = await createPhotoFolder(join(workspace, "first"), { count: 4, gps: false });
  // Re-encoded copies: the same scenes, but new files and therefore new photo IDs.
  second = join(workspace, "second");
  await createPhotoFolder(join(workspace, "second-source"), { count: 4, gps: false }).then(async source => {
    await mkdir(second, { recursive: true });
    for (const name of (await readdir(source)).filter(file => file.endsWith(".jpg")))
      await sharp(join(source, name)).jpeg({ quality: 61 }).toFile(join(second, name));
  });
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

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  if (response.isError) throw new Error(text);
  return JSON.parse(text);
};

// @verifies DES-MCP-TOOLS, ARCH-MCP
describe("selection reasons after a draft is replaced", () => {
  // @verifies REQ-MCP-4
  it("ignores the old record when Studio or the CLI writes a new draft under the same slug", async () => {
    const root = join(workspace, "site");
    const server = createServer({ root, dependencies: offline }),
      client = new Client({ name: "reasons-test", version: "1.0.0" }),
      [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const created = await call(client, "create_draft", { folder: first, people: "include", locationPrivacy: "hidden", title: "Same Slug" });
    await deleteTrip(root, created.slug);
    // A run outside MCP (as Studio or `pnpm trip` does) writes a new draft under the same slug and no reasons record.
    const rerun = await runTrip(
      { input: second, people: "include", title: "Same Slug", maxPhotos: 36, privacy: "hidden", force: true, dryRun: false, demo: false },
      { ...offline, root }
    );
    expect(rerun.slug).toBe(created.slug);

    const latest = JSON.parse(await readFile(join(root, ".trip-output/selection.json"), "utf8")) as { reasons: Record<string, string> };
    const draft = await call(client, "get_draft", { slug: created.slug });
    expect(draft.photos.length).toBeGreaterThan(0);
    for (const photo of draft.photos) expect(photo.reason).toBe(latest.reasons[photo.id]);
    for (const photo of draft.photos) expect(photo.reason).toMatch(/^Selected:/);
  });
});
