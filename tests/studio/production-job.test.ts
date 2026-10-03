import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateStaticExport } from "@/lib/publishing/privacy";
import type { StudioJob } from "@/lib/studio/types";
import { createPhotoFolder, removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
let sandbox = "",
  workspace = "",
  base = "",
  input = "",
  studio: ChildProcess | undefined;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

// Everything below runs against the *packed* package, started exactly as `pnpm studio` starts it, with no prior `out/` build.
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-studio-"));
  const { stdout } = await execute("npm", ["pack", "--pack-destination", sandbox, "--ignore-scripts", "--json"], { cwd: repoRoot });
  workspace = join(sandbox, "project");
  await mkdir(workspace);
  await execute("tar", [
    "-xzf",
    join(sandbox, (JSON.parse(stdout) as Array<{ filename: string }>)[0]!.filename),
    "-C",
    workspace,
    "--strip-components=1",
  ]);
  await symlink(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");
  input = await createPhotoFolder(workspace, { count: 8, gps: false });
  const port = await freePort();
  studio = spawn(process.execPath, [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), "scripts/studio.ts", "--no-open"], {
    cwd: workspace,
    env: { ...process.env, OPENAI_API_KEY: "", WANDERPAGE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  studio.stdout!.on("data", chunk => (output += String(chunk)));
  studio.stderr!.on("data", chunk => (output += String(chunk)));
  for (let attempt = 0; attempt < 240 && !output.includes("is ready at"); attempt++) {
    if (studio.exitCode !== null) throw new Error(`Studio exited early:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  expect(output).toContain("is ready at");
  base = `http://127.0.0.1:${port}`;
}, 300_000);
afterAll(async () => {
  studio?.kill("SIGTERM");
  if (sandbox) await removeTempWorkspace(sandbox);
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

// @verifies DES-CLI-LAUNCH, ARCH-CLI, ARCH-STUDIO, REQ-CLI-01, REQ-UI-01, SN-06
describe("a new user's first launch (packed package, no prior build)", () => {
  it("serves the Studio page and the landing page instead of 'Not found'", async () => {
    const page = await fetch(`${base}/studio`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Wanderpage");
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});

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
