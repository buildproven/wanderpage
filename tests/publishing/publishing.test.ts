import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import rawManifest from "@/data/trip.demo.json";
import type { PhotoRecord } from "@/lib/photos/types";
import { publishPhoto, outputBytes } from "@/lib/publishing/images";
import { validateStaticExport } from "@/lib/publishing/privacy";
import { writeReports } from "@/lib/publishing/report";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { syncPublishedAssets } from "@/lib/trips/assets";
import { setTripPublished } from "@/lib/trips/publish";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("publishing");
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

async function photoWithMetadata(directory: string, id: string) {
  await mkdir(directory, { recursive: true });
  const workingPath = join(directory, `${id}.jpg`);
  await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#4d7f9a" } })
    .withExif({ IFD0: { Model: "Secret Camera 9000" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "45/1 52/1 4200/100" } })
    .jpeg()
    .toFile(workingPath);
  return { id, workingPath, width: 2400, height: 1600 } as PhotoRecord;
}

// @verifies DES-PUB-IMAGES, REQ-PUB-02, ARCH-PUBLISH, SN-04, SN-08
describe("published derivatives", () => {
  it("writes three resized WebP files that carry no EXIF, XMP, or IPTC metadata", async () => {
    const photo = await photoWithMetadata(join(workspace, "images-src"), "u-abc123"),
      assets = join(workspace, "images-out");
    expect((await sharp(photo.workingPath).metadata()).exif).toBeDefined();
    const published = await publishPhoto(photo, assets);
    expect(published.srcLarge).toBe("/trip/generated/u-abc123-large.webp");
    const widths: number[] = [];
    for (const name of ["large", "medium", "thumb"]) {
      const metadata = await sharp(join(assets, `u-abc123-${name}.webp`)).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.exif ?? metadata.xmp ?? metadata.iptc).toBeUndefined();
      widths.push(metadata.width!);
    }
    expect(widths).toEqual([1800, 900, 420]);
    expect(published.blurDataURL).toMatch(/^data:image\/webp;base64,/);
    expect(await outputBytes((await readdir(assets)).map(name => join(assets, name)))).toBeGreaterThan(0);
  });
});

// @verifies DES-PUB-PRIVACY, REQ-PUB-04, ARCH-PUBLISH, SN-03, SN-04
describe("static artifact privacy scan", () => {
  it("accepts a clean artifact", async () => {
    const clean = join(workspace, "scan-clean");
    await mkdir(clean, { recursive: true });
    await writeFile(join(clean, "index.html"), "<html>A clean story</html>");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
      .webp()
      .toFile(join(clean, "photo.webp"));
    expect((await validateStaticExport(clean)).errors).toEqual([]);
  });

  it("reports image metadata, local paths, report paths, key assignments, and configured secrets", async () => {
    const dirty = join(workspace, "scan-dirty");
    await mkdir(dirty, { recursive: true });
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
      .withExif({ IFD0: { Model: "Secret Camera 9000" } })
      .jpeg()
      .toFile(join(dirty, "leaky.jpg"));
    await writeFile(join(dirty, "a.html"), "see /Users/someone/Pictures and .trip-output/report");
    await writeFile(join(dirty, "b.js"), "const x = 'OPENAI_API_KEY=abc'");
    await writeFile(join(dirty, "c.json"), '{"token":"super-secret-value-123"}');
    const { errors } = await validateStaticExport(dirty, ["super-secret-value-123", "short"]);
    expect(errors.some(error => error.endsWith("leaky.jpg: embedded metadata"))).toBe(true);
    expect(errors.filter(error => error.includes("a.html")).length).toBeGreaterThanOrEqual(2);
    expect(errors.some(error => error.includes("b.js"))).toBe(true);
    expect(errors.some(error => error.includes("c.json: contains a configured secret"))).toBe(true);
  });
});

// @verifies DES-PUB-REPORT, REQ-SEL-03, REQ-PUB-07, ARCH-PUBLISH, SN-05
describe("local decision report", () => {
  it("lists a reason for every photo and omits file paths and GPS", async () => {
    const output = join(workspace, "report"),
      photo = (id: string): PhotoRecord =>
        ({
          id,
          hash: id,
          sourcePath: "/Users/someone/Pictures/secret.jpg",
          workingPath: "/cache/x",
          analysisPath: "/cache/y",
          width: 1,
          height: 1,
          gps: { lat: 45.8821, lon: -123.9622 },
          technical: { overall: 70 },
          perceptualHash: "0",
          rejectionReasons: [],
        }) as unknown as PhotoRecord;
    const [a, b] = [photo("u-a"), photo("u-b")] as [PhotoRecord, PhotoRecord];
    const selection = { selected: [a], rejected: [b], heroId: "u-a", reasons: { "u-a": "Selected: strong", "u-b": "Exact duplicate" } };
    await writeReports(output, [a, b], selection, [], { basicEdit: true, provider: "deterministic-mock" });
    const files = await Promise.all(
      ["photo-analysis.json", "selection.json", "run-summary.json", "report/index.html"].map(name => readFile(join(output, name), "utf8"))
    );
    const all = files.join("\n");
    expect(all).toContain("Exact duplicate");
    expect(all).toContain("Selected: strong");
    expect(all).not.toContain("/Users/someone");
    expect(all).not.toContain("45.8821");
    expect(files[3]).toContain("Basic edit:");
  });
});

// @verifies DES-PUB-STORE, REQ-PUB-03, ARCH-PUBLISH, SN-05
describe("private drafts and publication", () => {
  it("exposes assets only for published trips and fails when a published trip lacks them", async () => {
    const root = join(workspace, "store");
    await mkdir(join(root, "data/trips"), { recursive: true });
    for (const slug of ["alpha", "beta"]) {
      await mkdir(join(root, ".trip-assets", slug), { recursive: true });
      await writeFile(join(root, ".trip-assets", slug, "p-large.webp"), "x");
      await writeFile(
        join(root, "data/trips", `${slug}.json`),
        JSON.stringify({ ...TripManifestSchema.parse(rawManifest), published: false })
      );
    }
    await syncPublishedAssets(root);
    await expect(access(join(root, "public/trip/generated/alpha"))).rejects.toThrow();
    await setTripPublished(root, "alpha", true);
    await expect(access(join(root, "public/trip/generated/alpha/p-large.webp"))).resolves.toBeUndefined();
    await expect(access(join(root, "public/trip/generated/beta"))).rejects.toThrow();
    await setTripPublished(root, "alpha", false);
    await expect(access(join(root, "public/trip/generated/alpha"))).rejects.toThrow();
    await mkdir(join(root, "data/trips"), { recursive: true });
    await writeFile(join(root, "data/trips/gamma.json"), JSON.stringify({ ...TripManifestSchema.parse(rawManifest), published: true }));
    await expect(syncPublishedAssets(root)).rejects.toThrow(/missing its private image assets/);
  });
});
