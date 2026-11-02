import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@/lib/ai/provider";
import type { PublishOptions } from "@/lib/automation/publish-tools";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { createServer } from "@/mcp/server";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "";
const offline = {
  aiProvider: new MockAIProvider(),
  inferDestinations: async () => [],
  enrichDestination: async () => ({ introduction: "", facts: [], sources: [] }),
};

async function connect(root: string, publishing?: PublishOptions) {
  const server = createServer({ root, dependencies: offline, publishing });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as Array<{ text?: string }>)[0]?.text ?? "";
  return { isError: response.isError === true, text, data: response.isError ? undefined : JSON.parse(text) };
}

beforeAll(async () => {
  workspace = await createTempWorkspace("mcp-rollback");
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

// @verifies DES-MCP-PUBLISH, ARCH-MCP
describe("publish_site rollback", () => {
  // @verifies REQ-MCP-7
  it("keeps an already-published draft published, and deploys nothing, when a later publish fails the scan", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const photos = await createPhotoFolder(workspace, { count: 8 }),
      root = join(workspace, "site");
    await mkdir(root, { recursive: true });
    const created = await call(await connect(root), "create_draft", { folder: photos, people: "include", locationPrivacy: "hidden" });
    const slug = created.data.slug as string,
      manifestPath = join(root, "data/trips", `${slug}.json`);
    const build = (leak: boolean) => async (site: string) => {
      await mkdir(join(site, "out"), { recursive: true });
      await writeFile(join(site, "out/index.html"), leak ? "<p>/Users/alice/Pictures/IMG_1.jpg</p>" : "<p>Clean</p>");
    };

    const first = await call(await connect(root, { buildSite: build(false) }), "publish_site", { slug });
    expect(first.isError, first.text).toBe(false);
    const published = await readFile(manifestPath, "utf8");

    const deploy = vi.fn(async () => undefined);
    const second = await call(await connect(root, { buildSite: build(true), deploy }), "publish_site", { slug });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/nothing was deployed/);
    expect(deploy).not.toHaveBeenCalled();
    expect(await readFile(manifestPath, "utf8")).toBe(published);
    expect(TripManifestSchema.parse(JSON.parse(published)).published).toBe(true);
    expect(await readdir(join(root, "public/trip/generated"))).toContain(slug);
    vi.restoreAllMocks();
  }, 120_000);
});
