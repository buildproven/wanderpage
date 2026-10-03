import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { groupDuplicates } from "@/lib/photos/duplicates";
import { discoverPhotos, ingestPhotos } from "@/lib/photos/ingest";
import { hammingDistance, perceptualHash, technicalScores } from "@/lib/photos/scoring";
import type { PhotoRecord } from "@/lib/photos/types";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("ingest");
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

// @verifies DES-PHOTO-INGEST, REQ-ING-01, ARCH-INGEST, SN-01
describe("photo discovery", () => {
  it("finds supported photos in nested folders, sorted, and ignores everything else", async () => {
    const root = join(workspace, "discover");
    await mkdir(join(root, "day-two", "deep"), { recursive: true });
    for (const name of ["b.JPG", "a.png", "day-two/c.webp", "day-two/deep/d.heic", "day-two/e.HEIF", "notes.txt", "clip.mov", "raw.cr2"])
      await writeFile(join(root, name), "x");
    const found = (await discoverPhotos(root)).map(path => path.slice(root.length + 1));
    expect(found).toEqual(["a.png", "b.JPG", "day-two/c.webp", "day-two/deep/d.heic", "day-two/e.HEIF"]);
  });
});

// @verifies DES-PHOTO-INGEST, REQ-ING-02, REQ-ING-03, ARCH-INGEST, SN-04, SN-07
describe("photo ingest", () => {
  it("reads capture data locally, caches by content, and never touches the original", async () => {
    const root = join(workspace, "ingest-ok"),
      cache = join(root, "cache");
    await mkdir(root, { recursive: true });
    const input = await createPhotoFolder(root, { count: 4 }),
      paths = await discoverPhotos(input),
      before = await Promise.all(paths.map(digest));
    const messages: string[] = [];
    const first = await ingestPhotos(paths, cache, message => messages.push(message));
    expect(first).toHaveLength(paths.length);
    const gps = first.filter(photo => photo.gps);
    expect(gps.length).toBeGreaterThan(0);
    expect(first.some(photo => photo.captureTime?.startsWith("2026-09-"))).toBe(true);
    expect(first.every(photo => photo.camera === "Wanderpage Integration Camera" || photo.camera === undefined)).toBe(true);
    expect(first.every(photo => photo.id === `u-${photo.hash.slice(0, 12)}`)).toBe(true);
    expect(await Promise.all(paths.map(digest))).toEqual(before);
    expect((await readdir(cache)).some(name => name.endsWith("-photo-v1.json"))).toBe(true);

    const cached: string[] = [];
    await ingestPhotos(paths, cache, message => cached.push(message));
    expect(cached.every(message => message.startsWith("Cache hit"))).toBe(true);
    const forced: string[] = [];
    await ingestPhotos(paths, cache, message => forced.push(message), true);
    expect(forced.every(message => message.startsWith("Ingested"))).toBe(true);
  });

  it("skips an unreadable file with a visible message and keeps going", async () => {
    const root = join(workspace, "ingest-corrupt");
    await mkdir(root, { recursive: true });
    const good = join(root, "good.jpg"),
      bad = join(root, "bad.jpg");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#6a8fb0" } })
      .jpeg()
      .toFile(good);
    await writeFile(bad, "this is not an image");
    const messages: string[] = [],
      records = await ingestPhotos([bad, good], join(root, "cache"), message => messages.push(message));
    expect(records.map(record => record.sourcePath)).toEqual([good]);
    expect(messages.some(message => message.startsWith("Skipped bad.jpg"))).toBe(true);
  });

  it("rejects low-resolution and nearly empty frames with a reason", async () => {
    const root = join(workspace, "ingest-quality");
    await mkdir(root, { recursive: true });
    const small = join(root, "small.jpg"),
      black = join(root, "black.jpg");
    await sharp({ create: { width: 320, height: 200, channels: 3, background: "#808080" } })
      .jpeg()
      .toFile(small);
    await sharp({ create: { width: 1000, height: 800, channels: 3, background: "#000000" } })
      .jpeg()
      .toFile(black);
    const records = await ingestPhotos([small, black], join(root, "cache")),
      byName = (name: string) => records.find(record => record.sourcePath.endsWith(name))!;
    expect(byName("small.jpg").rejectionReasons).toContain("Resolution below 640×480");
    expect(byName("black.jpg").rejectionReasons).toContain("Nearly empty or severely exposed frame");
  });
});

// @verifies DES-PHOTO-SCORE, REQ-ING-04, ARCH-INGEST
describe("technical scoring", () => {
  it("scores a detailed frame sharper than a blurred copy and keeps every score in range", async () => {
    const root = join(workspace, "score");
    await mkdir(root, { recursive: true });
    const noise = Buffer.alloc(400 * 300 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
    const detailed = join(root, "detailed.png"),
      blurred = join(root, "blurred.png");
    await sharp(noise, { raw: { width: 400, height: 300, channels: 3 } })
      .png()
      .toFile(detailed);
    await sharp(detailed).blur(12).png().toFile(blurred);
    const sharpScore = await technicalScores(detailed, 400, 300),
      blurScore = await technicalScores(blurred, 400, 300);
    expect(sharpScore.sharpness).toBeGreaterThan(blurScore.sharpness);
    for (const value of Object.values(sharpScore)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("gives identical pictures identical hashes and different pictures distant hashes", async () => {
    const root = join(workspace, "hash");
    await mkdir(root, { recursive: true });
    const ramp = Buffer.alloc(90 * 80);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 90; x++) ramp[y * 90 + x] = (x * 255) / 89;
    const a = join(root, "a.png"),
      b = join(root, "b.png");
    await sharp(ramp, { raw: { width: 90, height: 80, channels: 1 } })
      .png()
      .toFile(a);
    await sharp(ramp, { raw: { width: 90, height: 80, channels: 1 } })
      .flop()
      .png()
      .toFile(b);
    const hashA = await perceptualHash(a);
    expect(hashA).toHaveLength(16);
    expect(hammingDistance(hashA, await perceptualHash(a))).toBe(0);
    expect(hammingDistance(hashA, await perceptualHash(b))).toBeGreaterThan(7);
  });
});

const record = (id: string, hash: string, perceptual: string): PhotoRecord => ({
  id,
  hash,
  sourcePath: "/private/input",
  workingPath: "/cache",
  analysisPath: "/cache",
  width: 1200,
  height: 800,
  technical: { sharpness: 80, exposure: 80, contrast: 80, colorBalance: 80, resolution: 80, noise: 80, clipping: 80, overall: 80 },
  perceptualHash: perceptual,
  rejectionReasons: [],
});

// @verifies DES-PHOTO-DUP, REQ-ING-05, ARCH-INGEST
describe("duplicate grouping", () => {
  it("marks byte-identical photos as exact duplicates of the first", () => {
    const photos = groupDuplicates([record("a", "same", "0".repeat(16)), record("b", "same", "0".repeat(16))]);
    expect(photos[0]!.duplicateOf).toBeUndefined();
    expect(photos[1]!.duplicateOf).toBe("a");
    expect(photos[1]!.rejectionReasons).toContain("Exact duplicate");
  });

  it("clusters near-identical compositions within seven bits and leaves distant ones alone", () => {
    const base = "0000000000000000",
      near = "000000000000007f",
      far = "ffffffffffffffff";
    const [a, b, c] = groupDuplicates([record("a", "1", base), record("b", "2", near), record("c", "3", far)]) as [
      PhotoRecord,
      PhotoRecord,
      PhotoRecord,
    ];
    expect(hammingDistance(base, near)).toBe(7);
    expect(a.similarityCluster).toBeDefined();
    expect(b.similarityCluster).toBe(a.similarityCluster);
    expect(c.similarityCluster).toBeUndefined();
  });
});
