import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTrip } from "@/lib/pipeline/run";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { copySiteScaffold, createTempWorkspace, removeTempWorkspace } from "./helpers/workspace";

describe("deterministic demo", () => {
  it("reports the size of the published responsive image set", async () => {
    const workspace = await createTempWorkspace("demo-size");
    try {
      await copySiteScaffold(workspace);
      await runTrip(
        {
          people: "exclude",
          maxPhotos: 36,
          privacy: "approximate",
          force: false,
          dryRun: false,
          demo: true,
        },
        { root: workspace }
      );

      const manifest = TripManifestSchema.parse(JSON.parse(await readFile(join(workspace, "data/trip.demo.json"), "utf8"))),
        referencedAssets = new Set(manifest.photos.flatMap(photo => [photo.srcLarge, photo.srcMedium, photo.srcThumb])),
        imageDirectory = join(workspace, "public/trip/demo"),
        expectedBytes = (
          await Promise.all([...referencedAssets].map(async src => (await stat(join(workspace, "public", src.replace(/^\//, "")))).size))
        ).reduce((total, bytes) => total + bytes, 0),
        summary = JSON.parse(await readFile(join(workspace, ".trip-output/run-summary.json"), "utf8")) as {
          publishedSizeBytes: number;
        };

      expect(new Set([...referencedAssets].map(src => src.replace("/trip/demo/", "")))).toEqual(new Set(await readdir(imageDirectory)));
      expect(summary.publishedSizeBytes).toBe(expectedBytes);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("reports a dangling manifest asset as an actionable error", async () => {
    const workspace = await createTempWorkspace("demo-missing-asset");
    try {
      await copySiteScaffold(workspace);
      const manifestPath = join(workspace, "data/trip.demo.json"),
        manifest = TripManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
      manifest.photos[0]!.srcLarge = "/trip/demo/missing-large.webp";
      await writeFile(manifestPath, JSON.stringify(manifest));

      await expect(
        runTrip(
          {
            people: "exclude",
            maxPhotos: 36,
            privacy: "approximate",
            force: false,
            dryRun: false,
            demo: true,
          },
          { root: workspace }
        )
      ).rejects.toThrow("Demo manifest references a missing published asset: /trip/demo/missing-large.webp");
    } finally {
      await removeTempWorkspace(workspace);
    }
  });
});
