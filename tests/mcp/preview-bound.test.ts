import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import rawManifest from "@/data/trip.demo.json";
import { maxPreviewSheets, photosPerSheet, previewDraft } from "@/lib/automation/publish-tools";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { createServer } from "@/mcp/server";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

const slug = "bound-fixture",
  cap = maxPreviewSheets * photosPerSheet;
let workspace = "",
  roots = 0,
  webp: Buffer;

/** A private draft of `count` photos, each with its own published medium WebP file. */
async function draft(count: number) {
  const root = join(workspace, `root-${++roots}`),
    assets = join(root, ".trip-assets", slug),
    base = TripManifestSchema.parse(rawManifest),
    source = base.photos[0]!;
  await mkdir(assets, { recursive: true });
  await mkdir(join(root, "data/trips"), { recursive: true });
  const photos = Array.from({ length: count }, (_, index) => ({
    ...source,
    id: `p-${index}`,
    srcMedium: `/trip/generated/${slug}/p-${index}-medium.webp`,
  }));
  await Promise.all(photos.map(photo => writeFile(join(assets, `${photo.id}-medium.webp`), webp)));
  const manifest = { ...base, published: false, heroPhotoId: photos[0]!.id, photos };
  await writeFile(join(root, "data/trips", `${slug}.json`), JSON.stringify(manifest, null, 2));
  return { root, ids: photos.map(photo => photo.id) };
}

beforeAll(async () => {
  workspace = await createTempWorkspace("preview-bound");
  webp = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a6" } })
    .webp()
    .toBuffer();
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

// @verifies DES-MCP-PUBLISH, REQ-MCP-6
describe("BUI-1993: preview_draft response size is bounded", () => {
  it("caps the preview at 8 sheets, within claude.ai's 20 images per message", () => {
    expect(maxPreviewSheets).toBe(8);
    expect(maxPreviewSheets).toBeLessThanOrEqual(20);
  });

  it("returns every sheet and no omittedPhotos field when the draft fits the cap exactly", async () => {
    const { root, ids } = await draft(cap);
    const preview = await previewDraft(root, slug);
    expect(preview.sheets).toHaveLength(maxPreviewSheets);
    expect(preview.photoIds).toEqual(ids);
    expect(preview).not.toHaveProperty("omittedPhotos");
  }, 60_000);

  it("returns at most 8 sheets and counts the photos left out when the draft is one photo over", async () => {
    const { root, ids } = await draft(cap + 1);
    const preview = await previewDraft(root, slug);
    expect(preview.sheets).toHaveLength(maxPreviewSheets);
    expect(preview.photoIds).toEqual(ids);
    expect(preview).toMatchObject({ omittedPhotos: 1 });
  }, 60_000);

  it("still refuses a draft whose missing WebP belongs to a photo past the cap", async () => {
    const { root, ids } = await draft(cap + 1);
    await rm(join(root, ".trip-assets", slug, `${ids.at(-1)}-medium.webp`));
    await expect(previewDraft(root, slug)).rejects.toThrow(/missing/);
  }, 60_000);

  it("returns 8 images and reports the omitted count over MCP for a 500-photo draft", async () => {
    const { root, ids } = await draft(500);
    const server = createServer({ root });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const response = await client.callTool({ name: "preview_draft", arguments: { slug } });
    const content = response.content as Array<{ type: string; text?: string; mimeType?: string }>;
    expect(response.isError).not.toBe(true);
    const images = content.filter(item => item.type === "image");
    expect(images).toHaveLength(maxPreviewSheets);
    expect(images.every(image => image.mimeType === "image/jpeg")).toBe(true);
    expect(JSON.parse(content[0]!.text!)).toMatchObject({ slug, sheets: maxPreviewSheets, photoIds: ids, omittedPhotos: 500 - cap });
  }, 120_000);
});
