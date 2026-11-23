import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
// A fake pnpm logs its arguments to FAKE_PNPM_LOG and exits with FAKE_PNPM_EXIT, so the preflight's install never touches a real store.
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
      FAKE_PNPM_LOG: join(sandbox, "pnpm-args.log"),
      FAKE_PNPM_EXIT: "0",
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
  await writeFile(join(sandbox, "bin", "pnpm"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_PNPM_LOG"\nexit "$FAKE_PNPM_EXIT"\n');
  await chmod(join(sandbox, "bin", "pnpm"), 0o755);
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

// Commits files to main and pushes them, so a test can give the fixture a CHANGELOG and version manifests; undo with dropMainCommit.
async function commitToMain(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, path, ".."), { recursive: true });
    await writeFile(join(work, path), content);
  }
  git(work, "add", ".");
  git(work, "commit", "-m", "fixture files");
  git(work, "push", "origin", "main");
}
function dropMainCommit() {
  git(work, "checkout", "main");
  git(work, "reset", "--hard", "HEAD~1");
  git(work, "push", "--force", "origin", "main");
}
const committerEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const versionFiles = {
  "manifest.json": '{\n  "name": "fixture",\n  "version": "1.2.3"\n}\n',
  ".claude-plugin/plugin.json": '{\n  "name": "fixture",\n  "version": "1.2.3"\n}\n',
};
const localBranches = () => git(work, "branch", "--format=%(refname:short)");
const remoteBranches = () => git(work, "ls-remote", "--heads", "origin");

// @verifies DES-REL-RELEASE, REQ-REL-02
describe("release stops before bumping when CHANGELOG has no entry for the next version (BUI-2137)", () => {
  it.each([
    ["minor", "# Changelog\n\n## 1.2.3 — 2026-11-20\n\n- Old.\n", "1.3.0"],
    ["patch", "# Changelog\n\n## 1.3.0 — 2026-11-22\n\n- Next minor.\n\n## 1.2.3 — 2026-11-20\n", "1.2.4"],
    ["major", "# Changelog\n\n## 2.0.0-beta.1 — 2026-11-22\n\n## 1.2.3 — 2026-11-20\n", "2.0.0"],
  ])(
    "REQ-REL-02: a %s release with no entry for its version stops and leaves the tree and branches unchanged",
    async (bump, changelog, version) => {
      await commitToMain({ "CHANGELOG.md": changelog, ...versionFiles });
      try {
        const head = git(work, "rev-parse", "HEAD");
        const [branchesBefore, remoteBefore] = [localBranches(), remoteBranches()];
        const outcome = await scriptWith(committerEnv, "release-open-pr.ts", bump);
        expect(outcome.code).toBe(1);
        expect(outcome.stderr).toContain(`CHANGELOG.md has no entry for ${version}.`);
        expect(outcome.stderr).toContain(`Add a "## ${version}" entry to CHANGELOG.md on main first`);
        expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
        expect(git(work, "rev-parse", "HEAD")).toBe(head);
        expect(git(work, "status", "--porcelain")).toBe("");
        expect(localBranches()).toBe(branchesBefore);
        expect(remoteBranches()).toBe(remoteBefore);
      } finally {
        dropMainCommit();
      }
    }
  );

  it("REQ-REL-02: a missing CHANGELOG.md stops the release with the same message", async () => {
    await commitToMain(versionFiles);
    try {
      const branchesBefore = localBranches();
      const outcome = await scriptWith(committerEnv, "release-open-pr.ts", "patch");
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain("CHANGELOG.md has no entry for 1.2.4.");
      expect(git(work, "status", "--porcelain")).toBe("");
      expect(localBranches()).toBe(branchesBefore);
    } finally {
      dropMainCommit();
    }
  });

  it("REQ-REL-02: an entry that is not first, below an older one, stops the release as the push check would", async () => {
    await commitToMain({ "CHANGELOG.md": "# Changelog\n\n## 1.2.3 — 2026-11-20\n\n## 1.2.4 — 2026-11-22\n", ...versionFiles });
    try {
      const outcome = await scriptWith(committerEnv, "release-open-pr.ts", "patch");
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain("CHANGELOG.md's first entry is 1.2.3, older than the next version 1.2.4.");
      expect(git(work, "status", "--porcelain")).toBe("");
    } finally {
      dropMainCommit();
    }
  });

  it("REQ-REL-02: a package version that is not MAJOR.MINOR.PATCH stops the release before anything is bumped", async () => {
    await commitToMain({ "package.json": '{"name":"fixture","version":"1.3.0-beta.1"}\n', "CHANGELOG.md": "## 1.3.0\n", ...versionFiles });
    try {
      const outcome = await scriptWith(committerEnv, "release-open-pr.ts", "minor");
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain('package.json version "1.3.0-beta.1" is not MAJOR.MINOR.PATCH');
      expect(git(work, "status", "--porcelain")).toBe("");
    } finally {
      dropMainCommit();
    }
  });

  it("REQ-REL-02: with the next version's entry first, the release bumps, commits and pushes as before", async () => {
    await commitToMain({ "CHANGELOG.md": "# Changelog\n\n## 1.3.0 — 2026-11-23\n\n- New.\n\n## 1.2.3 — 2026-11-20\n", ...versionFiles });
    const branch = "chore/release-v1.3.0";
    try {
      const outcome = await scriptWith(committerEnv, "release-open-pr.ts", "minor");
      expect(outcome.code, outcome.stderr).toBe(0);
      expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe(branch);
      expect(JSON.parse(git(work, "show", `${branch}:package.json`))).toMatchObject({ version: "1.3.0" });
      expect(git(work, "ls-remote", "--heads", "origin", branch)).toContain(`refs/heads/${branch}`);
    } finally {
      git(work, "checkout", "main");
      git(work, "branch", "-D", branch);
      git(work, "push", "origin", "--delete", branch);
      dropMainCommit();
    }
  });
});

// @verifies DES-REL-RELEASE, REQ-REL-02
describe("release preflight installs with the frozen lockfile before any bump (BUI-2137)", () => {
  beforeEach(() => rm(join(sandbox, "pnpm-args.log"), { force: true }));

  it("REQ-REL-02: runs pnpm install --frozen-lockfile and passes when it succeeds", async () => {
    const outcome = await script("release-preflight.ts");
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(await readFile(join(sandbox, "pnpm-args.log"), "utf8")).toBe("install --frozen-lockfile\n");
  });

  it("REQ-REL-02: stops when the install fails, before any file, branch or commit changes", async () => {
    const [head, branchesBefore] = [git(work, "rev-parse", "HEAD"), localBranches()];
    const outcome = await scriptWith({ FAKE_PNPM_EXIT: "1" }, "release-preflight.ts");
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('"pnpm install --frozen-lockfile" failed');
    expect(outcome.stdout).not.toContain("Release preflight passed");
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(localBranches()).toBe(branchesBefore);
  });

  it("REQ-REL-02: does not install when main's CI has not passed", async () => {
    const outcome = await scriptWith({ FAKE_GH_RUNS: "[]" }, "release-preflight.ts");
    expect(outcome.code).toBe(1);
    await expect(readFile(join(sandbox, "pnpm-args.log"), "utf8")).rejects.toThrow();
  });
});

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
