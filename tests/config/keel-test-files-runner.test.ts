import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { planTestFiles, repoPath } from "../helpers/keel-test-files";
import { repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const keel = JSON.parse(await readFile(join(repoRoot, "keel.json"), "utf8")) as Record<string, unknown>;
const command = String(keel.testFilesCommand);

// Expands the {files} placeholder the way Keel does and runs the command from the repository root.
function runTestFiles(files: string[]) {
  const [program, ...args] = command.split(" ").flatMap(part => (part === "{files}" ? files : [part]));
  return execute(program!, args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "1" } });
}

const runners = (files: string[]) => planTestFiles(files, repoRoot).map(step => step.args.slice(0, 3).join(" "));

// @verifies REQ-KEELCFG-1
describe("Keel's test-files command never passes without running a test (BUI-1564)", () => {
  it("runs the test-files runner on the given files, with no --passWithNoTests", () => {
    expect(command).toBe("node node_modules/tsx/dist/cli.mjs tests/helpers/keel-test-files.ts {files}");
    expect(command).not.toContain("--passWithNoTests");
  });

  it("sends a Playwright spec to Playwright after the build pnpm test gives it, not to vitest", () => {
    const steps = planTestFiles(["tests/e2e/viewer.spec.ts"], repoRoot);
    expect(steps.map(step => [step.command, ...step.args].join(" "))).toEqual([
      "node node_modules/tsx/dist/cli.mjs scripts/trip.ts --demo",
      "pnpm exec next build --webpack",
      "node node_modules/tsx/dist/cli.mjs scripts/static-export.ts",
      "pnpm exec playwright test tests/e2e/viewer.spec.ts",
    ]);
    expect(steps.at(-1)!.env).toEqual({ CI: "1" });
  });

  it("sends other test files to vitest and splits a mixed set between both runners", () => {
    expect(planTestFiles(["tests/slug.test.ts"], repoRoot)).toEqual([
      { command: "pnpm", args: ["exec", "vitest", "run", "tests/slug.test.ts"] },
    ]);
    const mixed = planTestFiles(["tests/slug.test.ts", "tests/e2e/story.spec.ts", "tests/e2e/viewer.spec.ts"], repoRoot);
    expect(mixed[0]!.args).toEqual(["exec", "vitest", "run", "tests/slug.test.ts"]);
    expect(mixed.at(-1)!.args).toEqual(["exec", "playwright", "test", "tests/e2e/story.spec.ts", "tests/e2e/viewer.spec.ts"]);
  });

  it("keeps a path with a space as one argument and reads ./ and absolute paths as repository paths", () => {
    expect(planTestFiles(["tests/site/a b.test.ts"], repoRoot)[0]!.args).toEqual(["exec", "vitest", "run", "tests/site/a b.test.ts"]);
    expect(repoPath("./tests/e2e/viewer.spec.ts", repoRoot)).toBe("tests/e2e/viewer.spec.ts");
    expect(repoPath(join(repoRoot, "tests/e2e/viewer.spec.ts"), repoRoot)).toBe("tests/e2e/viewer.spec.ts");
    expect(runners(["./tests/e2e/viewer.spec.ts"]).at(-1)).toBe("exec playwright test");
  });

  it("drops files that are not tests and refuses a set with no test in it", () => {
    expect(planTestFiles(["tests/helpers/workspace.ts", "tests/slug.test.ts", "tests/tsconfig.json"], repoRoot)[0]!.args).toEqual([
      "exec",
      "vitest",
      "run",
      "tests/slug.test.ts",
    ]);
    expect(() => planTestFiles(["tests/helpers/workspace.ts", "tests/tsconfig.json"], repoRoot)).toThrow(
      "No test file among the given files"
    );
    expect(() => planTestFiles([], repoRoot)).toThrow("(none)");
    expect(() => planTestFiles(["node_modules/x/a.test.ts"], repoRoot)).toThrow("No test file");
  });

  it("names a Playwright spec that Playwright itself runs", async () => {
    const [, ...args] = planTestFiles(["tests/e2e/viewer.spec.ts"], repoRoot).at(-1)!.args;
    const { stdout } = await execute("pnpm", ["exec", ...args, "--list"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    });
    expect(stdout).toContain("viewer.spec.ts");
    expect(stdout).toMatch(/Total: [1-9]\d* tests? in 1 file/);
  }, 60_000);

  it("fails, and does not pass, when the given files hold no test", async () => {
    await expect(runTestFiles(["tests/helpers/workspace.ts"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("No test file among the given files"),
    });
  }, 60_000);

  it("runs and passes a vitest file it is given", async () => {
    const { stdout } = await runTestFiles(["tests/slug.test.ts"]);
    expect(stripVTControlCharacters(stdout)).toMatch(/Test Files\s+1 passed \(1\)/);
  }, 60_000);

  it("fails when a given vitest file fails, so base can prove red", async () => {
    await expect(runTestFiles(["tests/no-such-file.test.ts"])).rejects.toMatchObject({ code: 1 });
  }, 60_000);
});
