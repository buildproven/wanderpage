import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
let sandbox = "",
  unpacked = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-package-"));
  const { stdout } = await execute("npm", ["pack", "--pack-destination", sandbox, "--ignore-scripts", "--json"], { cwd: repoRoot });
  const tarball = join(sandbox, (JSON.parse(stdout) as Array<{ filename: string }>)[0]!.filename);
  unpacked = join(sandbox, "unpacked");
  await mkdir(unpacked);
  await execute("tar", ["-xzf", tarball, "-C", unpacked, "--strip-components=1"]);
  await symlink(join(repoRoot, "node_modules"), join(unpacked, "node_modules"), "dir");
}, 120_000);
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});

// @verifies ARCH-RELEASE, ARCH-CLI, REQ-REL-01, REQ-CLI-01, SN-06, SN-11
describe("the published package", () => {
  it("contains everything the application imports, so a new user's project builds", async () => {
    const files = await readdir(unpacked);
    for (const required of [
      "workflows",
      "proxy.ts",
      "db",
      "app",
      "components",
      "lib",
      "scripts",
      "bin",
      "next.config.ts",
      "tsconfig.json",
      ".env.example",
    ])
      expect(files, `${required} is missing from the package`).toContain(required);
    await execute(join(repoRoot, "node_modules/.bin/next"), ["build", "--webpack", unpacked], {
      cwd: unpacked,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      maxBuffer: 20_000_000,
    });
    expect((await stat(join(unpacked, ".next"))).isDirectory()).toBe(true);
  }, 300_000);
});
