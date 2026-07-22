import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import rawManifest from "@/data/trip.demo.json";
import { syncPublishedAssets } from "@/lib/trips/assets";
import { deleteTrip, getTrip, listTrips, setTripPublished, writeTrip } from "@/lib/trips/publish";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace";

describe("trip publish controls", () => {
  it("keeps legacy manifests published when the flag is absent", () => {
    expect(TripManifestSchema.parse(rawManifest).published).toBe(true);
  });

  it("toggles publish state without deleting the trip file", async () => {
    const workspace = await createTempWorkspace("publish"),
      directory = join(workspace, "data/trips"),
      manifest = TripManifestSchema.parse(rawManifest);
    try {
      await mkdir(directory, { recursive: true });
      await mkdir(join(workspace, ".trip-assets/a-line-along-the-pacific"), { recursive: true });
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

  it("writes, reads, and deletes only the requested trip manifest", async () => {
    const workspace = await createTempWorkspace("publish-delete"),
      directory = join(workspace, "data/trips"),
      first = TripManifestSchema.parse({ ...rawManifest, title: "First trip" }),
      second = TripManifestSchema.parse({ ...rawManifest, title: "Second trip" });
    try {
      await mkdir(directory, { recursive: true });
      await writeTrip(workspace, "first-trip", { ...first, published: false });
      await writeTrip(workspace, "second-trip", second);
      await mkdir(join(workspace, ".trip-assets/second-trip"), { recursive: true });
      expect((await getTrip(workspace, "first-trip"))?.published).toBe(false);

      await deleteTrip(workspace, "first-trip");
      await expect(access(join(directory, "first-trip.json"))).rejects.toThrow();
      expect((await getTrip(workspace, "second-trip"))?.title).toBe("Second trip");
      await expect(writeTrip(workspace, "../outside", second)).rejects.toThrow("Trip slug is invalid");
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it("keeps the current public assets when a published trip is missing its private assets", async () => {
    const workspace = await createTempWorkspace("publish-atomic"),
      manifest = TripManifestSchema.parse(rawManifest);
    try {
      await writeTrip(workspace, "missing-assets", manifest);
      await mkdir(join(workspace, "public/trip/generated/current"), { recursive: true });
      await writeFile(join(workspace, "public/trip/generated/current/keep.webp"), "published");

      await expect(syncPublishedAssets(workspace)).rejects.toThrow("missing its private image assets");
      await expect(readFile(join(workspace, "public/trip/generated/current/keep.webp"), "utf8")).resolves.toBe("published");
    } finally {
      await removeTempWorkspace(workspace);
    }
  });
});
