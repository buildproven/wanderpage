import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copySiteScaffold, createPhotoFolder, createTempWorkspace, removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
type Outcome = { code: number; stdout: string; stderr: string };
const tsx = (script: string, args: string[], env: Record<string, string> = {}) =>
  execute("pnpm", ["exec", "tsx", join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENAI_API_KEY: "", ...env },
  }).then(
    ({ stdout, stderr }): Outcome => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }): Outcome => ({ code: error.code, stdout: error.stdout, stderr: error.stderr })
  );

let workspace = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("cli");
  await copySiteScaffold(workspace);
  await draft("fixture-trip");
}, 60_000);
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

async function draft(slug: string, title = "Fixture Trip") {
  const demo = JSON.parse(await readFile(join(workspace, "data/trip.demo.json"), "utf8"));
  await mkdir(join(workspace, "data/trips"), { recursive: true });
  await mkdir(join(workspace, ".trip-assets", slug), { recursive: true });
  await cp(join(workspace, "public/trip/demo/coast-hero-thumb.webp"), join(workspace, ".trip-assets", slug, "photo.webp"));
  await writeFile(join(workspace, "data/trips", `${slug}.json`), JSON.stringify({ ...demo, title, published: false }, null, 2));
}

async function snapshot(path = workspace): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (["node_modules", ".next"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(child));
    else
      result[relative(workspace, child)] = createHash("sha256")
        .update(await readFile(child))
        .digest("hex");
  }
  return result;
}

const agent = (args: string[]) => tsx("scripts/wanderpage.ts", [...args, "--json", "--workspace", workspace]);
const one = (outcome: Outcome) => {
  const lines = outcome.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as {
    contractVersion: string;
    operation: string;
    ok: boolean;
    data?: Record<string, unknown>;
    receipt?: { id: string; changed: boolean; manifestDigest?: string; assetTreeDigest?: string };
    error?: { code: string; message: string };
  };
};

// @verifies DES-CLI-AGENT, ARCH-AGENT, REQ-CLI-03, SN-09
describe("agent contract wanderpage/v1", () => {
  it("answers read-only commands with one versioned JSON result and changes nothing", async () => {
    const photos = await createPhotoFolder(workspace, { count: 4 }),
      before = await snapshot();
    const inspect = one(await agent(["inspect", photos])),
      list = one(await agent(["draft:list"])),
      show = one(await agent(["draft:show", "fixture-trip"])),
      validate = one(await agent(["draft:validate", "fixture-trip"]));
    for (const result of [inspect, list, show, validate]) {
      expect(result).toMatchObject({ contractVersion: "wanderpage/v1", ok: true, receipt: { changed: false } });
      expect(result.receipt!.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(inspect.data).toMatchObject({ supportedPhotos: 6 });
    expect(list.data!.drafts).toEqual([{ slug: "fixture-trip", title: "Fixture Trip", published: false }]);
    expect(validate.receipt!.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("uses fixed exit codes and a JSON error envelope for every failure class", async () => {
    const invalid = await agent(["draft:show", "Not_A_Slug"]),
      missing = await agent(["draft:show", "no-such-draft"]),
      workspaceMissing = await tsx("scripts/wanderpage.ts", ["draft:list", "--json", "--workspace", join(workspace, "nope")]);
    expect([invalid.code, missing.code, workspaceMissing.code]).toEqual([2, 4, 4]);
    expect(one(invalid)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect(one(missing)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  }, 60_000);
});

// @verifies DES-CLI-LAUNCH, ARCH-CLI, REQ-CLI-03, SN-09
describe("installed launcher agent commands", () => {
  const installed = (args: string[]) =>
    execute(process.execPath, [join(repoRoot, "bin/wanderpage.js"), ...args, "--json", "--workspace", workspace], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: dirname(process.execPath) },
    }).then(
      ({ stdout, stderr }): Outcome => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }): Outcome => ({
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      })
    );

  it("runs from any directory without pnpm or a project and keeps the contract's exit codes", async () => {
    expect(one(await installed(["draft:list"]))).toMatchObject({ contractVersion: "wanderpage/v1", ok: true });
    const invalid = await installed(["draft:show", "Not_A_Slug"]);
    expect(invalid.code).toBe(2);
    expect(one(invalid)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect(invalid.stderr).not.toContain("failed to start");
  }, 60_000);
});

// @verifies DES-CLI-AGENT, REQ-CLI-04, REQ-CLI-05, REQ-PUB-03, ARCH-AGENT, SN-05, SN-09
describe("agent publish safety", () => {
  it("publishes and unpublishes only on explicit request and reports what it changed", async () => {
    const published = one(await agent(["draft:publish", "fixture-trip"]));
    expect(published).toMatchObject({ ok: true, data: { published: true }, receipt: { changed: true } });
    expect(published.receipt!.assetTreeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(join(workspace, "data/trips/fixture-trip.json"), "utf8")).published).toBe(true);
    expect(one(await agent(["draft:unpublish", "fixture-trip"]))).toMatchObject({ data: { published: false } });
    expect(JSON.parse(await readFile(join(workspace, "data/trips/fixture-trip.json"), "utf8")).published).toBe(false);
  }, 60_000);

  it("refuses to publish a draft that fails the privacy scan and leaves it private", async () => {
    await draft("leaky-trip", "Saved at /Users/someone/Pictures");
    const outcome = await agent(["draft:publish", "leaky-trip"]);
    expect(outcome.code).toBe(3);
    expect(one(outcome)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(JSON.parse(await readFile(join(workspace, "data/trips/leaky-trip.json"), "utf8")).published).toBe(false);
    await rename(join(workspace, "data/trips/leaky-trip.json"), join(workspace, "leaky-trip.json.bak"));
  }, 60_000);

  it("rejects a symlinked asset tree instead of following it", async () => {
    await draft("linked-trip");
    await rename(join(workspace, ".trip-assets/linked-trip"), join(workspace, "real-assets"));
    await symlink(join(workspace, "real-assets"), join(workspace, ".trip-assets/linked-trip"));
    const outcome = await agent(["draft:publish", "linked-trip"]);
    expect(outcome.code).toBe(3);
    expect(one(outcome).error!.message).toMatch(/Symbolic links are not allowed/);
  }, 60_000);
});

// @verifies DES-CLI-TRIP, ARCH-CLI, REQ-CLI-02, SN-07
describe("trip command validation", () => {
  it.each([
    [["--input", "/nowhere"], /--people include\|exclude is required/],
    [["--input", "/nowhere", "--people", "everyone"], /--people must be include or exclude/],
    [["--input", "/nowhere", "--people", "include", "--max-photos", "5"], /--max-photos must be an integer from 12 to 60/],
    [["--input", "/nowhere", "--people", "include", "--max-photos", "61"], /--max-photos must be an integer from 12 to 60/],
    [["--input", "/nowhere", "--people", "include", "--privacy", "exact"], /--privacy must be hidden, broad, approximate, or precise/],
  ])(
    "rejects %j before doing any work",
    async (args, message) => {
      const outcome = await tsx("scripts/trip.ts", args);
      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toMatch(message);
    },
    60_000
  );

  it("says what is missing when the photo folder has no supported photos", async () => {
    const empty = join(workspace, "empty-folder");
    await mkdir(empty, { recursive: true });
    const outcome = await tsx("scripts/trip.ts", ["--input", empty, "--people", "include"], { WANDERPAGE_WORKSPACE: workspace });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("No supported JPEG, PNG, WebP, HEIC, or HEIF photos were found");
  }, 60_000);
});

// @verifies DES-CLI-TRIP, REQ-PUB-03, SN-05
describe("trip publish commands", () => {
  const publish = (...args: string[]) => tsx("scripts/trip-publish.ts", args, { WANDERPAGE_WORKSPACE: workspace });

  it("lists, publishes, and unpublishes by name, and explains an unknown name", async () => {
    expect((await publish("list")).stdout).toMatch(/unpublished\s+fixture-trip\s+Fixture Trip/);
    expect((await publish("publish", "fixture-trip")).stdout).toContain("Published fixture-trip");
    expect((await publish("list")).stdout).toMatch(/^published\s+fixture-trip/m);
    expect((await publish("unpublish", "fixture-trip")).stdout).toContain("Unpublished fixture-trip");
    const unknown = await publish("publish", "nothing-here");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("No trip found at data/trips/nothing-here.json");
  }, 60_000);
});
