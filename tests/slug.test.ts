import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import rawManifest from "@/data/trip.demo.json";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { availableTripSlug, tripSlug } from "@/lib/trips/slug";
import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace";

describe("trip page names", () => {
  it("creates readable location and theme slugs", () => {
    expect(tripSlug("Oregon Coast — September Light")).toBe("oregon-coast-september-light");
    expect(tripSlug("São Miguel & the Azores")).toBe("sao-miguel-the-azores");
  });
  it("uses a safe fallback for punctuation-only titles", () => {
    expect(tripSlug("— ✈ —")).toBe("untitled-trip");
  });
  it("updates the same trip while allocating a distinct page for another date", async () => {
    const workspace = await createTempWorkspace("slugs"),
      directory = join(workspace, "data/trips"),
      manifest = TripManifestSchema.parse(rawManifest);
    try {
      await mkdir(directory, { recursive: true });
      expect(await availableTripSlug(directory, manifest)).toBe("a-line-along-the-pacific");
      await writeFile(join(directory, "a-line-along-the-pacific.json"), JSON.stringify(manifest));
      expect(await availableTripSlug(directory, manifest)).toBe("a-line-along-the-pacific");
      const later = { ...manifest, dateRange: { start: "2027-09-04", end: "2027-09-07" } };
      expect(await availableTripSlug(directory, later)).toBe("a-line-along-the-pacific-2027");
    } finally {
      await removeTempWorkspace(workspace);
    }
  });
});
