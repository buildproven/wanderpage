import { describe, expect, it } from "vitest";
import manifest from "@/data/trip.demo.json";
import { TripManifestSchema } from "@/lib/schemas/trip";
// @verifies DES-PUB-SCHEMA, REQ-PUB-01
describe("TripManifest", () => {
  it("validates the versioned demo", () => {
    expect(TripManifestSchema.parse(manifest).schemaVersion).toBe("1.0");
  });
});
