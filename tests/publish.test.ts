import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import rawManifest from "@/data/trip.demo.json";
import { listTrips, setTripPublished } from "@/lib/trips/publish";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace";

describe("trip publish controls", () => {
  it("defaults generated trips to published", () => {
    expect(TripManifestSchema.parse(rawManifest).published).toBe(true);
  });

  it("toggles publish state without deleting the trip file", async () => {
    const workspace = await createTempWorkspace("publish"),
      directory = join(workspace, "data/trips"),
      manifest = TripManifestSchema.parse(rawManifest);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "a-line-along-the-pacific.json"), JSON.stringify(manifest));

      const unpublished = await setTripPublished(workspace, "a-line-along-the-pacific", false);
      expect(unpublished.published).toBe(false);
      const onDisk = JSON.parse(await readFile(join(directory, "a-line-along-the-pacific.json"), "utf8"));
      expect(onDisk.published).toBe(false);

      const republished = await setTripPublished(workspace, "a-line-along-the-pacific", true);
      expect(republished.published).toBe(true);

      const trips = await listTrips(workspace);
      expect(trips).toHaveLength(1);
      expect(trips[0]?.manifest.published).toBe(true);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("throws for a trip that does not exist", async () => {
    const workspace = await createTempWorkspace("publish-missing");
    try {
      await mkdir(join(workspace, "data/trips"), { recursive: true });
      await expect(setTripPublished(workspace, "does-not-exist", false)).rejects.toThrow("No trip found");
    } finally {
      await removeTempWorkspace(workspace);
    }
  });
});
