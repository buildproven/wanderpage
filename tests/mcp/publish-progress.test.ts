import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@/lib/ai/provider";
import { readDraft } from "@/lib/automation/local";
import { publishSite, type PublishOptions, type PublishProgress } from "@/lib/automation/publish-tools";
import { createServer } from "@/mcp/server";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "",
  photos = "",
  sites = 0;
const offline = {
  aiProvider: new MockAIProvider(),
  inferDestinations: async () => [],
  enrichDestination: async () => ({ introduction: "", facts: [], sources: [] }),
};

const build = (leak: boolean) => async (site: string) => {
  await mkdir(join(site, "out"), { recursive: true });
  await writeFile(join(site, "out/index.html"), leak ? "<p>/Users/alice/Pictures/IMG_1.jpg</p>" : "<p>Clean</p>");
};

async function connect(root: string, publishing?: PublishOptions) {
  const server = createServer({ root, dependencies: offline, publishing });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function draft() {
  const root = join(workspace, `site-${++sites}`);
  await mkdir(root, { recursive: true });
  const response = await (
    await connect(root)
  ).callTool({ name: "create_draft", arguments: { folder: photos, people: "include", locationPrivacy: "hidden" } });
  const text = (response.content as Array<{ text?: string }>)[0]?.text ?? "";
  expect(response.isError, text).not.toBe(true);
  return { root, slug: JSON.parse(text).slug as string };
}

type Progress = { progress: number; total?: number; message?: string };

beforeAll(async () => {
  workspace = await createTempWorkspace("mcp-progress");
  photos = await createPhotoFolder(workspace, { count: 8 });
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

// @verifies DES-MCP-PUBLISH, ARCH-MCP
describe("REQ-MCP-8 publish_site progress", () => {
  // @verifies REQ-MCP-8
  it("REQ-MCP-8 sends one progress notification per stage (export, privacy scan, deploy) to a client that asks", async () => {
    const { root, slug } = await draft();
    const order: string[] = [];
    const seen: Progress[] = [];
    const client = await connect(root, {
      buildSite: async site => {
        order.push("build");
        await build(false)(site);
      },
      deploy: async () => {
        order.push("deploy");
      },
    });
    const response = await client.callTool(
      { name: "publish_site", arguments: { slug } },
      {
        onprogress: progress => {
          seen.push(progress);
          order.push(`progress:${progress.progress}`);
        },
      }
    );
    expect(response.isError).not.toBe(true);
    expect(seen.map(({ progress, total }) => ({ progress, total }))).toEqual([
      { progress: 0, total: 3 },
      { progress: 1, total: 3 },
      { progress: 2, total: 3 },
    ]);
    expect(seen.map(item => item.message)).toEqual([
      expect.stringMatching(/export/i),
      expect.stringMatching(/privacy scan/i),
      expect.stringMatching(/deploy/i),
    ]);
    // Each notification announces its stage before the stage runs.
    expect(order).toEqual(["progress:0", "build", "progress:1", "progress:2", "deploy"]);
  }, 120_000);

  // @verifies REQ-MCP-8
  it("REQ-MCP-8 sends no deploy notification when the privacy scan fails", async () => {
    const { root, slug } = await draft();
    const seen: Progress[] = [];
    const deploy = vi.fn(async () => undefined);
    const response = await (
      await connect(root, { buildSite: build(true), deploy })
    ).callTool({ name: "publish_site", arguments: { slug } }, { onprogress: progress => void seen.push(progress) });
    expect(response.isError).toBe(true);
    expect(deploy).not.toHaveBeenCalled();
    expect(seen.map(item => item.progress)).toEqual([0, 1]);
  }, 120_000);

  // @verifies REQ-MCP-8
  it("REQ-MCP-8 sends nothing when the call carries no progress token", async () => {
    const { root, slug } = await draft();
    const notify = vi.fn(async () => undefined);
    const result = await publishSite(root, slug, { buildSite: build(false) }, { notify });
    expect(result.privacy.passed).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  }, 120_000);

  // @verifies REQ-MCP-8
  it("REQ-MCP-8 echoes the caller's progress token on every notification", async () => {
    const { root, slug } = await draft();
    const notify = vi.fn<PublishProgress["notify"]>(async () => undefined);
    await publishSite(root, slug, { buildSite: build(false) }, { progressToken: "token-7", notify });
    expect(notify).toHaveBeenCalledTimes(3);
    for (const [notification] of notify.mock.calls) {
      expect(notification.method).toBe("notifications/progress");
      expect(notification.params).toMatchObject({ progressToken: "token-7", total: 3 });
    }
  }, 120_000);

  // @verifies REQ-MCP-8
  it("REQ-MCP-8 rolls the draft back and deploys nothing when a progress notification cannot be sent", async () => {
    const { root, slug } = await draft();
    const deploy = vi.fn(async () => undefined);
    const notify = vi.fn<PublishProgress["notify"]>(async notification => {
      if (notification.params.progress === 2) throw new Error("client went away");
    });
    await expect(publishSite(root, slug, { buildSite: build(false), deploy }, { progressToken: 0, notify })).rejects.toThrow(
      /client went away/
    );
    expect(deploy).not.toHaveBeenCalled();
    expect((await readDraft(root, slug)).published).toBe(false);
  }, 120_000);
});
