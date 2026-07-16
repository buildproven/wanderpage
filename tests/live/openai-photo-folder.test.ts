import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTrip } from "@/lib/pipeline/run";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

const enabled = process.env.WANDERPAGE_LIVE_TEST === "1";

describe.skipIf(!enabled)("live OpenAI photo-folder smoke test", () => {
  let workspace = "",
    input = "";
  beforeAll(async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when WANDERPAGE_LIVE_TEST=1");
    workspace = await createTempWorkspace("openai-live");
    input = await createPhotoFolder(workspace, { count: 2 });
  });
  afterAll(async () => {
    if (workspace) await removeTempWorkspace(workspace);
  });

  it("uses contact-sheet vision Structured Outputs and narrative generation in the real pipeline", async () => {
    const result = await runTrip(
      {
        input,
        people: "exclude",
        title: "Live OpenAI Smoke Test",
        maxPhotos: 12,
        privacy: "approximate",
        force: true,
        dryRun: false,
        demo: false,
      },
      { root: workspace }
    );
    expect(result.summary.provider).toBe("openai");
    expect(result.summary.modelCalls).toBeGreaterThanOrEqual(2);
    const manifest = TripManifestSchema.parse(JSON.parse(await readFile(join(workspace, `data/trips/${result.slug}.json`), "utf8")));
    expect(manifest.photos.length).toBeGreaterThan(0);
    expect(manifest.photos.every(photo => !photo.containsPeople)).toBe(true);
    expect(manifest.photos.every(photo => photo.alt.length > 8)).toBe(true);
  }, 180_000);
});
