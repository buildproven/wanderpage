import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTrip } from "@/lib/pipeline/run";
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

      const imageDirectory = join(workspace, "public/trip/demo"),
        expectedBytes = (
          await Promise.all((await readdir(imageDirectory)).map(async filename => (await stat(join(imageDirectory, filename))).size))
        ).reduce((total, bytes) => total + bytes, 0),
        summary = JSON.parse(await readFile(join(workspace, ".trip-output/run-summary.json"), "utf8")) as {
          publishedSizeBytes: number;
        };

      expect(summary.publishedSizeBytes).toBe(expectedBytes);
    } finally {
      await removeTempWorkspace(workspace);
    }
  });
});
