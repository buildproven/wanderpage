import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

// These tests spawn git and Node repeatedly while heavy builds run in parallel, so the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const execute = promisify(execFile);
// Inside a git hook GIT_DIR and friends point at the outer repository; the fixture repositories must never see them.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) as NodeJS.ProcessEnv;
let sandbox = "",
  work = "";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(),
  }).trim();
const passingQualityRuns = JSON.stringify([{ status: "completed", conclusion: "success", url: "https://example.test/runs/1" }]);
// A fake gh on PATH stands in for GitHub: it logs its arguments and prints FAKE_GH_RUNS, exiting with FAKE_GH_EXIT.
const script = (name: string, ...args: string[]) => scriptWith({}, name, ...args);
const scriptWith = (env: Record<string, string>, name: string, ...args: string[]) =>
  execute(process.execPath, [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), join(repoRoot, "scripts", name), ...args], {
    cwd: work,
    env: {
      ...cleanEnv(),
      PATH: `${join(sandbox, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_GH_LOG: join(sandbox, "gh-args.log"),
      FAKE_GH_RUNS: passingQualityRuns,
      FAKE_GH_EXIT: "0",
      ...env,
    },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr })
  );

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-release-"));
  const origin = join(sandbox, "origin.git");
  work = join(sandbox, "work");
  await mkdir(join(sandbox, "bin"));
  await writeFile(
    join(sandbox, "bin", "gh"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$FAKE_GH_LOG"\nprintf \'%s\' "$FAKE_GH_RUNS"\nexit "$FAKE_GH_EXIT"\n'
  );
  await chmod(join(sandbox, "bin", "gh"), 0o755);
  git(sandbox, "init", "--bare", "-b", "main", origin);
  git(sandbox, "clone", origin, work);
  git(work, "checkout", "-b", "main");
  await writeFile(join(work, "package.json"), '{"name":"fixture","version":"1.2.3"}\n');
  git(work, "add", ".");
  git(work, "commit", "-m", "init");
  git(work, "push", "-u", "origin", "main");
});
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});
beforeEach(() => {
  git(work, "checkout", "main");
  git(work, "reset", "--hard", "origin/main");
  git(work, "clean", "-fd");
});

// @verifies DES-REL-RELEASE, ARCH-RELEASE, REQ-REL-02, SN-11
describe("release safety checks", () => {
  it("passes on a clean main that matches origin", async () => {
    const outcome = await script("release-preflight.ts");
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("Release preflight passed");
  });

  it("refuses a dirty working tree, a feature branch, and a main that is behind origin", async () => {
    await writeFile(join(work, "dirty.txt"), "x");
    expect((await script("release-preflight.ts")).stderr).toContain("Working tree is not clean");
    await beforeEachReset();
    git(work, "checkout", "-b", "feature/x");
    expect((await script("release-preflight.ts")).stderr).toContain('must run from main (currently on "feature/x")');
    await beforeEachReset();
    const other = join(sandbox, "other");
    git(sandbox, "clone", join(sandbox, "origin.git"), other);
    await writeFile(join(other, "new.txt"), "x");
    git(other, "add", ".");
    git(other, "commit", "-m", "advance");
    git(other, "push", "origin", "main");
    expect((await script("release-preflight.ts")).stderr).toContain("Local main is not up to date with origin/main");
  });

  it("tags the version from main exactly once and pushes the tag", async () => {
    git(work, "pull", "--ff-only");
    const first = await script("release-tag.ts");
    expect(first.code).toBe(0);
    expect(git(work, "ls-remote", "--tags", "origin", "v1.2.3")).toContain("refs/tags/v1.2.3");
    const second = await script("release-tag.ts");
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already exists");
  });

  it("rejects an unknown version bump before touching anything", async () => {
    const outcome = await script("release-open-pr.ts", "huge");
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("Usage:");
    expect(git(work, "status", "--porcelain")).toBe("");
  });
});

// @verifies DES-REL-RELEASE, REQ-REL-02
describe("release preflight trusts main's CI instead of a local full suite (BUI-2093)", () => {
  it("REQ-REL-02: the release:* scripts run the preflight and never run pnpm check", async () => {
    const { scripts } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const release = Object.entries(scripts).filter(([name]) => name.startsWith("release:"));
    expect(release.map(([name]) => name)).toEqual(expect.arrayContaining(["release:patch", "release:minor", "release:major"]));
    for (const [name, command] of release) expect(command, name).not.toMatch(/\bpnpm\s+(run\s+)?check\b/);
    for (const bump of ["patch", "minor", "major"])
      expect(scripts[`release:${bump}`]).toBe(`pnpm release:preflight && tsx scripts/release-open-pr.ts ${bump}`);
  });

  it("REQ-REL-02: passes only when the quality workflow succeeded on main's exact HEAD", async () => {
    const head = git(work, "rev-parse", "HEAD");
    const outcome = await script("release-preflight.ts");
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain(head);
    const ghArgs = await readFile(join(sandbox, "gh-args.log"), "utf8");
    expect(ghArgs).toContain("run list --workflow quality.yml --branch main --commit " + head);
  });

  it("REQ-REL-02: an earlier success counts even when a newer run on the same commit is still going", async () => {
    const runs = JSON.stringify([
      { status: "in_progress", conclusion: "" },
      { status: "completed", conclusion: "success" },
    ]);
    expect((await scriptWith({ FAKE_GH_RUNS: runs }, "release-preflight.ts")).code).toBe(0);
  });

  it("REQ-REL-02: stops and names the commit when main's HEAD has no quality run", async () => {
    const head = git(work, "rev-parse", "HEAD");
    const outcome = await scriptWith({ FAKE_GH_RUNS: "[]" }, "release-preflight.ts");
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(`main's HEAD ${head} has no successful "quality" workflow run (no run found)`);
  });

  it("REQ-REL-02: stops and names the commit and run state when the quality run failed or is still running", async () => {
    const head = git(work, "rev-parse", "HEAD");
    const failed = JSON.stringify([{ status: "completed", conclusion: "failure", url: "https://example.test/runs/9" }]);
    const failure = await scriptWith({ FAKE_GH_RUNS: failed }, "release-preflight.ts");
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(
      `${head} has no successful "quality" workflow run (latest run completed: failure (https://example.test/runs/9))`
    );
    const running = await scriptWith({ FAKE_GH_RUNS: JSON.stringify([{ status: "queued", conclusion: "" }]) }, "release-preflight.ts");
    expect(running.code).toBe(1);
    expect(running.stderr).toContain(`${head} has no successful "quality" workflow run (latest run queued)`);
  });

  it("REQ-REL-02: stops and names the commit when gh fails or returns unreadable output", async () => {
    const head = git(work, "rev-parse", "HEAD");
    const ghDown = await scriptWith({ FAKE_GH_RUNS: "", FAKE_GH_EXIT: "4" }, "release-preflight.ts");
    expect(ghDown.code).toBe(1);
    expect(ghDown.stderr).toContain(`Could not read the "quality" workflow runs for main's HEAD ${head}`);
    for (const output of ["not json", '{"status":"completed"}']) {
      const unreadable = await scriptWith({ FAKE_GH_RUNS: output }, "release-preflight.ts");
      expect(unreadable.code).toBe(1);
      expect(unreadable.stderr).toContain(`gh returned unreadable "quality" workflow runs for main's HEAD ${head}`);
    }
  });
});

async function beforeEachReset() {
  git(work, "checkout", "main");
  git(work, "reset", "--hard", "origin/main");
  git(work, "clean", "-fd");
}

// @verifies ARCH-RELEASE, REQ-REL-02, SN-11
describe("trusted publishing workflow", () => {
  it("publishes from version tags on main with OIDC provenance and never uses a stored npm token", async () => {
    const workflow = await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toMatch(/tags: \["v\*"\]/);
    expect(workflow).toMatch(/id-token: write/);
    expect(workflow).toContain("npm publish --provenance --access public");
    expect(workflow).toContain("is not on main. Refusing to publish.");
    expect(workflow).toContain("does not match package.json version");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/);
  });
});
