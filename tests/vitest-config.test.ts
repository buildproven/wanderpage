import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, matchesGlob, relative } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import config from "../vitest.config";
import { createTempWorkspace, removeTempWorkspace, repoRoot } from "./helpers/workspace";

const execute = promisify(execFile);
const exclude = config.test?.exclude ?? [];

async function withLeftoverWorkspace<T>(run: (relativeTestFile: string, workspace: string) => Promise<T>) {
  const workspace = await createTempWorkspace("vitest-config");
  try {
    const testFile = join(workspace, "linked-project", "tests", "a.test.ts");
    await mkdir(join(testFile, ".."), { recursive: true });
    await writeFile(testFile, 'import { it } from "vitest";\nit("is a leftover copy", () => {});\n');
    return await run(relative(repoRoot, testFile), workspace);
  } finally {
    await removeTempWorkspace(workspace);
  }
}

// @verifies ARCH-QA, SN-11
describe("vitest config skips leftover test workspaces (BUI-2092)", () => {
  it("excludes the prefix tests/helpers/workspace.ts gives its repo-root workspaces", async () => {
    await withLeftoverWorkspace(async (relativeTestFile, workspace) => {
      // The prefix comes from the helper itself, so a renamed prefix fails this test instead of slipping past the exclude.
      expect(basename(workspace)).toMatch(/^\.wanderpage-test-vitest-config-/);
      expect(exclude.some(pattern => matchesGlob(relativeTestFile, pattern))).toBe(true);
    });
  });

  it("matches a copied test file in any leftover workspace at the repo root", () => {
    for (const file of [
      ".wanderpage-test-x/linked-project/tests/a.test.ts",
      ".wanderpage-test-mcp-symlink-y8wBg3/linked-project/tests/slug.test.ts",
    ]) {
      expect(exclude.some(pattern => matchesGlob(file, pattern))).toBe(true);
    }
  });

  it("still collects the repository's own unit tests", () => {
    for (const file of ["tests/slug.test.ts", "tests/vitest-config.test.ts", "tests/config/keel-config.test.ts"]) {
      expect(exclude.some(pattern => matchesGlob(file, pattern))).toBe(false);
    }
  });

  it("never lists a test file inside a leftover workspace", async () => {
    await withLeftoverWorkspace(async relativeTestFile => {
      const { stdout } = await execute(
        process.execPath,
        [join(repoRoot, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", "--staticParse"],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "1" }, maxBuffer: 16 * 1024 * 1024 }
      );
      expect(stdout).toContain("tests/slug.test.ts");
      expect(stdout).not.toContain(relativeTestFile);
      expect(stdout).not.toContain(".wanderpage-test-");
    });
  }, 60_000);
});
