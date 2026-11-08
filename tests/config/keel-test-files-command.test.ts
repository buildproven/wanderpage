import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { planTestFiles } from "../helpers/keel-test-files";
import { repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const keel = JSON.parse(await readFile(join(repoRoot, "keel.json"), "utf8")) as Record<string, unknown>;

// @verifies ARCH-QA, SN-11
describe("Keel test-files command", () => {
  it("passes when every given file is one vitest excludes (REQ-KEELCFG-1)", async () => {
    expect(keel.testFilesCommand).toBe("node node_modules/tsx/dist/cli.mjs tests/helpers/keel-test-files.ts {files}");
    // vitest.config.ts excludes Playwright specs under tests/e2e, so the command hands them to Playwright, which runs them.
    const [, ...args] = planTestFiles(["tests/e2e/viewer.spec.ts"], repoRoot).at(-1)!.args;
    await expect(
      execute("pnpm", ["exec", ...args, "--list"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "1" } })
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("viewer.spec.ts"),
    });
  }, 60_000);

  it("keeps every other key and value unchanged (REQ-KEELCFG-2)", () => {
    expect(Object.keys(keel).sort()).toEqual(
      ["acceptance", "checks", "install", "linearProject", "review", "smoke", "testCommand", "testFilesCommand"].sort()
    );
    expect(keel.checks).toEqual({ lint: "pnpm lint", typecheck: "pnpm typecheck", build: "pnpm build", test: "pnpm test" });
    expect(keel.testCommand).toBe("pnpm test");
    expect(keel.linearProject).toBe("Wanderpage");
    expect(keel.acceptance).toEqual({ audit: "pnpm audit --audit-level high --prod" });
    expect(keel.review).toBe(true);
    expect(keel.smoke).toBe('curl -fsS -o /dev/null --max-time 30 "$KEEL_DEPLOY_URL"');
    expect(keel.install).toBe("pnpm install --frozen-lockfile");
  });
});
