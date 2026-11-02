import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@/lib/ai/provider";
import type { PublishOptions } from "@/lib/automation/publish-tools";
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";
import { normalizeDraft } from "@/lib/trips/draft";
import { createServer } from "@/mcp/server";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "",
  base = "",
  slug = "",
  roots = 0;
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

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as Content[];
  const text = content[0]?.text ?? "";
  return { isError: response.isError === true, text, content, data: response.isError ? undefined : JSON.parse(text) };
}

/** A copy of the fixture workspace (one private draft made by the mock provider), so each test mutates its own. */
async function fork() {
  const root = join(workspace, `root-${++roots}`);
  await cp(base, root, { recursive: true });
  return root;
}
const manifestPath = (root: string) => join(root, "data/trips", `${slug}.json`);
const stored = async (root: string) => TripManifestSchema.parse(JSON.parse(await readFile(manifestPath(root), "utf8")));

beforeAll(async () => {
  workspace = await createTempWorkspace("mcp-publish");
  const photos = await createPhotoFolder(workspace, { count: 8 });
  base = join(workspace, "base");
  await mkdir(base, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const created = await call(await connect(base), "create_draft", {
    folder: photos,
    people: "include",
    locationPrivacy: "hidden",
    title: "Publish Fixture",
  });
  vi.restoreAllMocks();
  slug = created.data.slug;
  // The originals are gone from here on: preview and publish may only use what the pipeline published.
  await rm(photos, { recursive: true });
}, 120_000);
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// @verifies DES-MCP-PUBLISH, ARCH-MCP
describe("MCP edit, preview, and publish tools", () => {
  // @verifies REQ-MCP-1
  it("lists the edit, preview, and publish tools with strict input schemas", async () => {
    const { tools } = await (await connect(await fork())).listTools();
    for (const name of ["edit_draft", "preview_draft", "publish_site"]) {
      const tool = tools.find(item => item.name === name);
      expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    const extra = await call(await connect(await fork()), "edit_draft", { slug, surprise: true }).catch(error => ({
      isError: true,
      text: String(error),
    }));
    expect(extra.isError).toBe(true);
  });

  // @verifies REQ-MCP-5
  it("removes a photo, sets the hero, retitles, and edits a caption, then returns the written manifest", async () => {
    const root = await fork(),
      client = await connect(root),
      before = await stored(root);
    expect(before.photos.length).toBeGreaterThan(2);
    const [first, second, third] = before.photos;
    const { isError, data } = await call(client, "edit_draft", {
      slug,
      removePhotoIds: [first!.id],
      heroPhotoId: second!.id,
      title: "  Edited in chat  ",
      captions: [
        { photoId: third!.id, caption: "Tide pools at noon" },
        { photoId: second!.id, caption: "" },
      ],
    });
    expect(isError).toBe(false);
    const after = await stored(root);
    expect(data).toEqual({ slug, manifest: JSON.parse(JSON.stringify(after)) });
    expect(after.title).toBe("Edited in chat");
    expect(after.heroPhotoId).toBe(second!.id);
    expect(after.published).toBe(false);
    expect(after.photos.map(photo => photo.id)).toEqual(before.photos.slice(1).map(photo => photo.id));
    expect(after.photos.find(photo => photo.id === third!.id)?.caption).toBe("Tide pools at noon");
    expect(after.photos.find(photo => photo.id === second!.id)?.caption).toBeUndefined();
    for (const chapter of after.chapters) expect(chapter.photoIds).not.toContain(first!.id);
  });

  // @verifies REQ-MCP-5
  it("falls back to the first remaining photo when the hero is removed without a new one", async () => {
    const root = await fork(),
      before = await stored(root);
    const { data } = await call(await connect(root), "edit_draft", { slug, removePhotoIds: [before.heroPhotoId] });
    expect(data.manifest.heroPhotoId).toBe(data.manifest.photos[0].id);
    expect(data.manifest.photos.map((photo: { id: string }) => photo.id)).not.toContain(before.heroPhotoId);
  });

  // @verifies REQ-MCP-5
  it("returns a tool error and leaves the draft file unchanged for each invalid edit", async () => {
    const root = await fork(),
      client = await connect(root),
      original = await readFile(manifestPath(root), "utf8"),
      ids = (await stored(root)).photos.map(photo => photo.id);
    const invalid: Array<[Record<string, unknown>, RegExp]> = [
      [{ slug }, /at least one change/],
      [{ slug, removePhotoIds: ["no-such-photo"] }, /no-such-photo/],
      [{ slug, heroPhotoId: "no-such-photo" }, /no-such-photo/],
      [{ slug, captions: [{ photoId: "no-such-photo", caption: "x" }] }, /no-such-photo/],
      [{ slug, removePhotoIds: [ids[1]], heroPhotoId: ids[1] }, /both removed and the hero/],
      [{ slug, removePhotoIds: [ids[1]], captions: [{ photoId: ids[1], caption: "x" }] }, /removed/],
      [{ slug, removePhotoIds: ids }, /at least one selected photo/],
      [{ slug: "no-such-draft", title: "x" }, /no-such-draft/],
      [{ slug: "../trip.demo", title: "x" }, /slug/],
    ];
    for (const [args, reason] of invalid) {
      const outcome = await call(client, "edit_draft", args);
      expect(outcome.isError, JSON.stringify(args)).toBe(true);
      expect(outcome.text).toMatch(reason);
      expect(await readFile(manifestPath(root), "utf8")).toBe(original);
    }
    for (const args of [
      { slug, title: "   " },
      { slug, removePhotoIds: [] },
      { slug, title: "x".repeat(201) },
    ]) {
      const outcome = await call(client, "edit_draft", args).catch(error => ({ isError: true, text: String(error) }));
      expect(outcome.isError, JSON.stringify(args)).toBe(true);
    }
    expect(await readFile(manifestPath(root), "utf8")).toBe(original);
  });

  // @verifies REQ-MCP-5
  it("refuses to edit a published draft", async () => {
    const root = await fork(),
      manifest = await stored(root);
    await writeFile(manifestPath(root), JSON.stringify({ ...manifest, published: true }, null, 2));
    const original = await readFile(manifestPath(root), "utf8");
    const outcome = await call(await connect(root), "edit_draft", { slug, title: "Too late" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/published/);
    expect(await readFile(manifestPath(root), "utf8")).toBe(original);
  });

  // @verifies REQ-MCP-5
  it("shares Studio's draft check from lib/trips/draft", async () => {
    const manifest = await stored(await fork());
    expect(() => normalizeDraft({ ...manifest, photos: [manifest.photos[0]!, manifest.photos[0]!] })).toThrow(/more than once/);
    expect(normalizeDraft({ ...manifest, heroPhotoId: "gone" }).heroPhotoId).toBe(manifest.photos[0]!.id);
  });

  // @verifies REQ-MCP-6
  it("returns a JPEG contact sheet built from the published WebP files after the originals are gone", async () => {
    const root = await fork();
    // Without the pipeline's private working copies either, only the published WebP files remain to build from.
    await rm(join(root, ".trip-output"), { recursive: true, force: true });
    await rm(join(root, ".trip-cache"), { recursive: true, force: true });
    const manifest = await stored(root);
    const { isError, content, data } = await call(await connect(root), "preview_draft", { slug });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ slug, sheets: 1, photoIds: manifest.photos.map(photo => photo.id) });
    const images = content.filter(item => item.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe("image/jpeg");
    const metadata = await sharp(Buffer.from(images[0]!.data!, "base64")).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 1200, height: 1000 });
    expect(await readFile(manifestPath(root), "utf8")).toBe(JSON.stringify(manifest, null, 2));
  });

  // @verifies REQ-MCP-6
  it("splits a draft of more than 16 photos across contact sheets", async () => {
    const root = await fork(),
      manifest = await stored(root),
      assets = join(root, ".trip-assets", slug),
      source = manifest.photos[0]!;
    const photos: TripManifest["photos"] = [];
    for (let index = 0; index < 17; index++) {
      const id = `extra-${index}`;
      await cp(join(assets, source.srcMedium.split("/").pop()!), join(assets, `${id}-medium.webp`));
      photos.push({ ...source, id, srcMedium: `/trip/generated/${slug}/${id}-medium.webp` });
    }
    await writeFile(manifestPath(root), JSON.stringify({ ...manifest, photos, heroPhotoId: photos[0]!.id }, null, 2));
    const { content, data } = await call(await connect(root), "preview_draft", { slug });
    expect(data.sheets).toBe(2);
    expect(content.filter(item => item.type === "image")).toHaveLength(2);
  });

  // @verifies REQ-MCP-6
  it("returns a tool error when a published WebP file is missing or the image is not a draft WebP", async () => {
    const root = await fork(),
      manifest = await stored(root),
      assets = join(root, ".trip-assets", slug),
      medium = (await readdir(assets)).find(name => name.endsWith("-medium.webp"))!;
    await rm(join(assets, medium));
    const missing = await call(await connect(root), "preview_draft", { slug });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/missing/);
    const other = await fork();
    await writeFile(
      manifestPath(other),
      JSON.stringify({ ...manifest, photos: [{ ...manifest.photos[0]!, srcMedium: "/Users/someone/IMG_1.jpg" }] }, null, 2)
    );
    const original = await call(await connect(other), "preview_draft", { slug });
    expect(original.isError).toBe(true);
    expect(original.text).toMatch(/no published WebP/);
    expect((await call(await connect(other), "preview_draft", { slug: "no-such-draft" })).isError).toBe(true);
  });

  // @verifies REQ-MCP-7
  it("publishes the draft, builds the site, scans it, and returns the out/ path and the scan result", async () => {
    const root = await fork(),
      deploy = vi.fn(async () => undefined);
    const buildSite = vi.fn(async (site: string) => {
      const published = await stored(site);
      await mkdir(join(site, "out"), { recursive: true });
      await writeFile(join(site, "out/index.html"), `<h1>${published.published ? published.title : "Nothing yet"}</h1>`);
      await sharp({ create: { width: 32, height: 32, channels: 3, background: "#4d7f9a" } })
        .webp()
        .toFile(join(site, "out/hero.webp"));
    });
    const { isError, data, text } = await call(await connect(root, { buildSite, deploy }), "publish_site", { slug });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({
      slug,
      published: true,
      path: `/trips/${slug}`,
      outputPath: join(root, "out"),
      privacy: { passed: true, scannedFiles: 2, findings: [] },
    });
    expect(data.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(buildSite).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledWith(join(root, "out"));
    expect((await stored(root)).published).toBe(true);
    expect(await readFile(join(root, "out/index.html"), "utf8")).toContain("Publish Fixture");
    expect((await readdir(join(root, "public/trip/generated", slug))).length).toBeGreaterThan(0);
  });

  // @verifies REQ-MCP-7
  it("returns the scan findings as a tool error, deploys nothing, and puts the draft back when the site leaks", async () => {
    const root = await fork(),
      deploy = vi.fn(async () => undefined);
    const buildSite = vi.fn(async (site: string) => {
      const published = (await stored(site)).published;
      await mkdir(join(site, "out"), { recursive: true });
      await writeFile(join(site, "out/index.html"), published ? "<p>/Users/alice/Pictures/IMG_1.jpg</p>" : "<p>No trips</p>");
      await sharp({ create: { width: 32, height: 32, channels: 3, background: "#4d7f9a" } })
        .withExif({ IFD0: { Model: "Leaky Camera" } })
        .jpeg()
        .toFile(join(site, "out/leak.jpg"));
    });
    const outcome = await call(await connect(root, { buildSite, deploy }), "publish_site", { slug });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/nothing was deployed/);
    expect(outcome.text).toMatch(/index\.html: matched/);
    expect(outcome.text).toMatch(/leak\.jpg: embedded metadata/);
    expect(deploy).not.toHaveBeenCalled();
    expect((await stored(root)).published).toBe(false);
    expect(buildSite).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, "out/index.html"), "utf8")).toBe("<p>No trips</p>");
    expect(await readdir(join(root, "public/trip/generated"))).not.toContain(slug);
  });

  // @verifies REQ-MCP-7
  it("reports a failed build with the rollback failure and leaves the draft unpublished", async () => {
    // The default build runs the project's static export, which this fixture workspace does not contain.
    const root = await fork(),
      deploy = vi.fn(async () => undefined);
    const outcome = await call(await connect(root, { deploy }), "publish_site", { slug });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/static-export/);
    expect(outcome.text).toMatch(/restoring the draft and rebuilding out\/ failed/);
    expect(deploy).not.toHaveBeenCalled();
    expect((await stored(root)).published).toBe(false);
  });

  // @verifies REQ-MCP-7
  it("puts the draft back when the hosting step fails after a clean scan", async () => {
    const root = await fork(),
      deploy = vi.fn(async () => {
        throw new Error("Vercel exited with code 1");
      });
    const buildSite = async (site: string) => {
      await mkdir(join(site, "out"), { recursive: true });
      await writeFile(join(site, "out/index.html"), "<p>Clean</p>");
    };
    const outcome = await call(await connect(root, { buildSite, deploy }), "publish_site", { slug });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/Vercel exited/);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect((await stored(root)).published).toBe(false);
  });

  // @verifies REQ-MCP-7
  it("refuses a draft that fails privacy validation before publishing or building anything", async () => {
    const root = await fork(),
      buildSite = vi.fn(async () => undefined),
      assets = join(root, ".trip-assets", slug),
      thumb = (await readdir(assets)).find(name => name.endsWith("-thumb.webp"))!;
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#4d7f9a" } })
      .withExif({ IFD0: { Model: "Leaky Camera" } })
      .webp()
      .toFile(join(assets, thumb));
    const original = await readFile(manifestPath(root), "utf8");
    const outcome = await call(await connect(root, { buildSite }), "publish_site", { slug });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/embedded metadata/);
    expect(buildSite).not.toHaveBeenCalled();
    expect(await readFile(manifestPath(root), "utf8")).toBe(original);
    expect((await call(await connect(root, { buildSite }), "publish_site", { slug: "no-such-draft" })).isError).toBe(true);
  });

  // @verifies REQ-MCP-5, REQ-MCP-7
  it("refuses to edit a draft after publish_site publishes it", async () => {
    const root = await fork();
    const buildSite = async (site: string) => {
      await mkdir(join(site, "out"), { recursive: true });
      await writeFile(join(site, "out/index.html"), "<p>Clean</p>");
    };
    const client = await connect(root, { buildSite });
    expect((await call(client, "publish_site", { slug })).isError).toBe(false);
    const edit = await call(client, "edit_draft", { slug, title: "Afterwards" });
    expect(edit.isError).toBe(true);
    expect(edit.text).toMatch(/unpublish/);
  });
});
