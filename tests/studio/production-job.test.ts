import { access, cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateStaticExport } from "@/lib/publishing/privacy";
import { createStudioServer } from "@/lib/studio/server";
import type { StudioJob } from "@/lib/studio/types";
import { copySiteScaffold, createPhotoFolder, createTempWorkspace, removeTempWorkspace, repoRoot } from "../helpers/workspace";

let workspace = "",
  base = "",
  input = "",
  studio: ReturnType<typeof createStudioServer>;

beforeAll(async () => {
  workspace = await createTempWorkspace("studio-job");
  await copySiteScaffold(workspace);
  await cp(join(repoRoot, "assets"), join(workspace, "assets"), { recursive: true });
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await cp(join(repoRoot, "scripts/static-export.ts"), join(workspace, "scripts/static-export.ts"));
  for (const file of ["postcss.config.mjs"]) await cp(join(repoRoot, file), join(workspace, file));
  await symlink(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");
  input = await createPhotoFolder(workspace, { count: 8, gps: false });
  delete process.env.OPENAI_API_KEY;
  studio = createStudioServer({ port: 0, root: workspace });
  base = (await studio.start()).replace(/\/studio$/, "");
}, 120_000);
afterAll(async () => {
  await studio?.stop();
  if (workspace) await removeTempWorkspace(workspace);
});

const call = (path: string, method = "GET", body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { Origin: base, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const exists = (path: string) =>
  access(join(workspace, path)).then(
    () => true,
    () => false
  );

// @verifies DES-STUDIO-SERVER, ARCH-STUDIO, ARCH-PUBLISH, ARCH-PIPELINE, REQ-UI-02, REQ-UI-03, REQ-PUB-03, REQ-PUB-04, REQ-PUB-06, REQ-AI-05, SN-01, SN-05, SN-06
describe("Studio production job (real pipeline, real static export)", () => {
  it("turns a photo folder into a private draft, then publishes it into the shareable static site", async () => {
    const created = await call("/api/jobs", "POST", {
      input,
      people: "include",
      maxPhotos: 12,
      privacy: "approximate",
      title: "Studio Production",
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    let job: StudioJob | undefined;
    for (let attempt = 0; attempt < 240; attempt++) {
      job = (await (await call(`/api/jobs/${id}`)).json()) as StudioJob;
      if (job.status === "complete" || job.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    expect(job?.error).toBeUndefined();
    expect(job?.status).toBe("complete");
    expect(job?.result?.path).toBe("/trips/studio-production");
    expect(job?.result?.manifest.published).toBe(false);
    expect(job?.result?.review?.privacy.passed).toBe(true);
    expect(await exists("out/index.html")).toBe(true);
    expect(await exists("out/trips/studio-production.html")).toBe(false);

    const published = await call("/api/trips/studio-production/publish", "POST");
    expect(published.status).toBe(200);
    expect(await exists("out/trips/studio-production.html")).toBe(true);
    expect((await validateStaticExport(join(workspace, "out"))).errors).toEqual([]);
    const page = await fetch(`${base}/trips/studio-production`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Studio Production");

    const unpublished = await call("/api/trips/studio-production/unpublish", "POST");
    expect(unpublished.status).toBe(200);
    expect(await exists("out/trips/studio-production.html")).toBe(false);
  }, 420_000);
});
