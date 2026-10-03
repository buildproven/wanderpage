import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
let sandbox = "",
  work = "";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
const script = (name: string, ...args: string[]) =>
  execute("pnpm", ["exec", "tsx", join(repoRoot, "scripts", name), ...args], { cwd: work }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr })
  );

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-release-"));
  const origin = join(sandbox, "origin.git");
  work = join(sandbox, "work");
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
