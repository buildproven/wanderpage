import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config";
import { repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const vitest = join(repoRoot, "node_modules/vitest/vitest.mjs");

async function runVitest(args: string[]) {
  return execute(process.execPath, [vitest, "run", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    // CI=1 and no TTY: the setting under which vitest 5's default reporter prints only a summary.
    env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 16 * 1024 * 1024,
  });
}

// @verifies ARCH-QA, SN-11
describe("vitest names each test file it runs (BUI-2171)", () => {
  it("configures the default reporter without its summary-only mode", () => {
    expect(config.test?.reporters).toEqual([["default", { summary: false }]]);
  });

  it("names every passing file off a TTY", async () => {
    const { stdout } = await runVitest(["tests/slug.test.ts", "tests/schema.test.ts"]);
    expect(stdout).toMatch(/✓ tests\/slug\.test\.ts \(\d+ tests?\)/);
    expect(stdout).toMatch(/✓ tests\/schema\.test\.ts \(\d+ tests?\)/);
    expect(stdout).toContain("Test Files  2 passed (2)");
  }, 60_000);

  it("still lets a command-line reporter replace the config reporter", async () => {
    const { stdout } = await runVitest(["--reporter=dot", "tests/slug.test.ts"]);
    expect(stdout).not.toContain("tests/slug.test.ts");
    expect(stdout).toContain("Test Files  1 passed (1)");
  }, 60_000);
});
