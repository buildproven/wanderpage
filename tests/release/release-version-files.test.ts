import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

// These tests spawn git, npm and Node while heavy builds run in parallel, so the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const execute = promisify(execFile);
// Inside a git hook GIT_DIR and friends point at the outer repository; the fixture repositories must never see them.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) as NodeJS.ProcessEnv;
let sandbox = "",
  work = "",
  fakeBin = "";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(),
  }).trim();
const openReleasePr = (bump: string) =>
  execute(process.execPath, [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), join(repoRoot, "scripts/release-open-pr.ts"), bump], {
    cwd: work,
    env: {
      ...cleanEnv(),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr })
  );

// Mirrors the layout of the real files: the top-level version sits next to nested objects that must not change.
const manifestFixture = `{
  "manifest_version": "0.3",
  "name": "fixture",
  "version": "1.2.3",
  "keywords": ["travel", "photos"],
  "server": {
    "type": "node",
    "mcp_config": { "command": "npx", "args": ["-y", "fixture@1.2.3"] }
  },
  "compatibility": {
    "runtimes": { "node": ">=24" },
    "version": "0.9.0"
  }
}
`;
const pluginFixture = `{
  "name": "fixture",
  "version": "1.2.3",
  "author": {
    "name": "Fixture"
  }
}
`;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-release-files-"));
  fakeBin = join(sandbox, "bin");
  await mkdir(fakeBin);
  // A stand-in for the GitHub CLI so the script can "open" a pull request without the network.
  await writeFile(join(fakeBin, "gh"), '#!/bin/sh\necho "https://github.com/example/fixture/pull/1"\n');
  await chmod(join(fakeBin, "gh"), 0o755);
  const origin = join(sandbox, "origin.git");
  work = join(sandbox, "work");
  git(sandbox, "init", "--bare", "-b", "main", origin);
  git(sandbox, "clone", origin, work);
  git(work, "checkout", "-b", "main");
  await writeFile(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "1.2.3"\n}\n');
  await writeFile(join(work, "manifest.json"), manifestFixture);
  await mkdir(join(work, ".claude-plugin"));
  await writeFile(join(work, ".claude-plugin/plugin.json"), pluginFixture);
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

const committed = (ref: string, path: string) => JSON.parse(git(work, "show", `${ref}:${path}`)) as Record<string, unknown>;

// @verifies DES-REL-RELEASE, ARCH-RELEASE, REQ-REL-02, REQ-AGENT-2
describe("REQ-REL-02 release PR bumps every version-carrying manifest", () => {
  it("REQ-REL-02 commits manifest.json and plugin.json at the new package version", async () => {
    const outcome = await openReleasePr("minor");
    expect(outcome.code, outcome.stderr).toBe(0);
    const branch = "chore/release-v1.3.0";
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe(branch);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(git(work, "show", "--name-only", "--format=", branch).split("\n").sort()).toEqual([
      ".claude-plugin/plugin.json",
      "manifest.json",
      "package.json",
    ]);

    expect(committed(branch, "package.json").version).toBe("1.3.0");
    expect(committed(branch, ".claude-plugin/plugin.json").version).toBe("1.3.0");
    const manifest = committed(branch, "manifest.json");
    expect(manifest.version).toBe("1.3.0");
    // Only the top-level version changes; nested versions and formatting stay as they were.
    expect(manifest.compatibility).toEqual({ runtimes: { node: ">=24" }, version: "0.9.0" });
    expect(git(work, "show", `${branch}:manifest.json`) + "\n").toBe(manifestFixture.replace('"version": "1.2.3"', '"version": "1.3.0"'));
    expect(git(work, "ls-remote", "--heads", "origin", branch)).toContain(`refs/heads/${branch}`);
  });

  it.each([
    ["manifest.json", '{\n  "name": "fixture",\n  "server": { "version": "1.2.3" }\n}\n', 'manifest.json has no top-level "version"'],
    [".claude-plugin/plugin.json", '{"name":"fixture","version":"1.2.3"}\n', "found 0"],
  ])("REQ-REL-02 refuses before bumping anything when %s has no editable top-level version", async (path, content, message) => {
    await writeFile(join(work, path), content);
    git(work, "commit", "-am", "break version line");
    git(work, "push", "origin", "main");
    try {
      const outcome = await openReleasePr("patch");
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain(message);
      expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
      expect(git(work, "status", "--porcelain")).toBe("");
      expect(git(work, "ls-remote", "--heads", "origin", "chore/release-v1.2.4")).toBe("");
    } finally {
      git(work, "reset", "--hard", "HEAD~1");
      git(work, "push", "--force", "origin", "main");
    }
  });
});
