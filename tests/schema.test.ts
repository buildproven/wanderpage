import { describe, expect, it } from "vitest";
import manifest from "@/data/trip.demo.json";
import { TripManifestSchema } from "@/lib/schemas/trip";
describe("TripManifest",()=>{it("validates the versioned demo",()=>{expect(TripManifestSchema.parse(manifest).schemaVersion).toBe("1.0");});});
