import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { createStudioServer, type StudioRunner } from "@/lib/studio/server";
import type { StudioJobResult } from "@/lib/studio/types";
import { createTempWorkspace, removeTempWorkspace, repoRoot } from "../helpers/workspace";

describe("local Studio server", () => {
  let workspace = "",
    base = "",
    finish: ((result: StudioJobResult) => void) | undefined,
    advance: ((stage: string, progress: number, message: string) => void) | undefined;
  const runner: StudioRunner = async (_request, onProgress) => {
    advance = onProgress;
    onProgress("analyze", 52, "Analyzing fixture contact sheet");
    return new Promise(resolve => {
      finish = resolve;
    });
  };
  let studio: ReturnType<typeof createStudioServer>;

  beforeAll(async () => {
    workspace = await createTempWorkspace("studio-server");
    await mkdir(join(workspace, "out"), { recursive: true });
    await writeFile(join(workspace, "out/studio.html"), "<!doctype html><title>Wanderpage Studio</title><h1>Local studio</h1>");
    studio = createStudioServer({ port: 0, runner, root: workspace });
    base = (await studio.start()).replace(/\/studio$/, "");
  });
  afterAll(async () => {
    await studio.stop();
    if (workspace) await removeTempWorkspace(workspace);
  });

  it("serves only the local interface and rejects untrusted origins", async () => {
    const page = await fetch(`${base}/studio`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Local studio");
    const denied = await fetch(`${base}/api/status`, { headers: { Origin: "https://attacker.example" } });
    expect(denied.status).toBe(403);
    const status = await fetch(`${base}/api/status`, { headers: { Origin: base } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ ready: true });
  });

  it("validates requests, exposes progress, prevents overlapping jobs, and returns results", async () => {
    const invalid = await post("/api/jobs", { input: "relative/photos", people: "include", maxPhotos: 36, privacy: "approximate" });
    expect(invalid.status).toBe(400);
    const response = await post("/api/jobs", {
      input: workspace,
      people: "include",
      maxPhotos: 36,
      privacy: "approximate",
      title: "Studio test",
    });
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    const running = await fetch(`${base}/api/jobs/${id}`, { headers: { Origin: base } });
    expect(await running.json()).toMatchObject({ status: "running", progress: { stage: "analyze", progress: 52 } });
    const conflict = await post("/api/jobs", { input: workspace, people: "include", maxPhotos: 36, privacy: "approximate" });
    expect(conflict.status).toBe(409);
    advance?.("build", 91, "Rebuilding static pages");
    await writeFile(join(workspace, "out/studio.html"), "partial build output");
    const studioDuringBuild = await fetch(`${base}/studio`);
    expect(await studioDuringBuild.text()).toContain("Local studio");
    finish?.(await fixtureResult());
    await expect
      .poll(async () => {
        const value = await fetch(`${base}/api/jobs/${id}`, { headers: { Origin: base } });
        return ((await value.json()) as { status: string }).status;
      })
      .toBe("complete");
  });

  function post(path: string, value: unknown) {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
});

async function fixtureResult(): Promise<StudioJobResult> {
  const manifest = TripManifestSchema.parse(JSON.parse(await readFile(join(repoRoot, "data/trip.demo.json"), "utf8")));
  return {
    path: "/trips/a-line-along-the-pacific",
    manifest,
    summary: { inputPhotos: 8, selectedPhotos: 8, duplicatesRemoved: 0 },
    selection: { selected: manifest.photos.map(photo => photo.id), rejected: [], reasons: {} },
  };
}
