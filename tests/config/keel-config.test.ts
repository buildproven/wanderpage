import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const readJson = async (file: string) => JSON.parse(await readFile(join(repoRoot, file), "utf8")) as Record<string, unknown>;
const keel = await readJson("keel.json"),
  packageJson = await readJson("package.json");

// Expands the {files} placeholder the way Keel does and runs the command from the repository root.
function runTestFiles(command: string, files: string[]) {
  const [program, ...args] = command.split(" ").flatMap(part => (part === "{files}" ? files : [part]));
  return execute(program!, args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "1" } });
}

// @verifies REQ-KEELCFG-1
describe("Keel runs only the tests a change touches", () => {
  const command = String(keel.testFilesCommand);

  it("runs vitest on the given files", () => {
    expect(command.split(" ")).toEqual(expect.arrayContaining(["vitest", "run", "{files}"]));
    expect(command.split(" ").filter(part => part === "{files}")).toHaveLength(1);
  });

  it("passes when every given file is one vitest does not run", async () => {
    await expect(runTestFiles(command, ["tests/e2e/viewer.spec.ts", "tests/e2e/story.spec.ts"])).resolves.toBeDefined();
  }, 60_000);

  it("needs --passWithNoTests: without it the same files fail", async () => {
    const strict = command.replace(" --passWithNoTests", "");
    expect(strict).not.toBe(command);
    await expect(runTestFiles(strict, ["tests/e2e/viewer.spec.ts"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("No test files found"),
    });
  }, 60_000);
});

// @verifies REQ-KEELCFG-2
describe("Keel gates work with the repository's own checks", () => {
  it("runs the package's lint, typecheck, build, and test scripts", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    expect(keel.checks).toEqual({ lint: "pnpm lint", typecheck: "pnpm typecheck", build: "pnpm build", test: "pnpm test" });
    for (const name of ["lint", "typecheck", "build", "test"]) expect(scripts[name], `package.json has no ${name} script`).toBeTruthy();
    expect(keel.testCommand).toBe("pnpm test");
  });

  it("installs from the lockfile, audits production dependencies, keeps review on, and reports to Wanderpage", () => {
    expect(keel.install).toBe("pnpm install --frozen-lockfile");
    expect(keel.acceptance).toEqual({ audit: "pnpm audit --audit-level high --prod" });
    expect(keel.review).toBe(true);
    expect(keel.linearProject).toBe("Wanderpage");
  });
});
