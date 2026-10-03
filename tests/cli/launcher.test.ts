import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
let sandbox = "",
  packageDir = "",
  shimDir = "",
  log = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-launcher-"));
  packageDir = join(sandbox, "package");
  shimDir = join(sandbox, "shim");
  log = join(sandbox, "pnpm.log");
  await mkdir(join(packageDir, "bin"), { recursive: true });
  await mkdir(join(packageDir, "data"), { recursive: true });
  await mkdir(join(packageDir, "node_modules/should-not-copy"), { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await cp(join(repoRoot, "bin/wanderpage.js"), join(packageDir, "bin/wanderpage.js"));
  await writeFile(join(packageDir, "package.json"), '{"name":"fake-wanderpage","type":"module"}\n');
  await writeFile(join(packageDir, ".env.example"), "OPENAI_API_KEY=\n");
  await writeFile(join(packageDir, "data/trip.demo.json"), "{}\n");
  await writeFile(join(shimDir, "pnpm"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  await chmod(join(shimDir, "pnpm"), 0o755);
});
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});

const launch = (args: string[], path: string) =>
  execute(process.execPath, [join(packageDir, "bin/wanderpage.js"), ...args], {
    env: { ...process.env, PATH: path, OPENAI_API_KEY: "" },
  });
const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);

// @verifies DES-CLI-LAUNCH, ARCH-CLI, REQ-CLI-01, SN-06
describe("one-command launcher", () => {
  it("scaffolds a project, installs once, seeds the env file, and starts Studio", async () => {
    const target = join(sandbox, "my-trips"),
      { stdout } = await launch([target, "--no-open"], shimDir);
    expect(stdout).toContain("Creating a new Wanderpage project");
    expect(stdout).toContain("No OPENAI_API_KEY found");
    expect((await stat(join(target, "package.json"))).isFile()).toBe(true);
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("OPENAI_API_KEY=\n");
    expect((await stat(join(target, "data/trips"))).isDirectory()).toBe(true);
    await expect(stat(join(target, "node_modules/should-not-copy"))).rejects.toThrow();
    expect(await calls()).toEqual(["--version", "install", "studio -- --no-open"]);
  });

  it("relaunches an existing project without reinstalling", async () => {
    const target = join(sandbox, "existing");
    await mkdir(join(target, "node_modules"), { recursive: true });
    await writeFile(join(target, "package.json"), "{}");
    await writeFile(log, "");
    const { stdout } = await launch([target, "--no-open"], shimDir);
    expect(stdout).toContain("Using existing Wanderpage project");
    expect(await calls()).toEqual(["--version", "studio -- --no-open"]);
  });

  it("tells the user exactly how to fix a missing pnpm and exits non-zero", async () => {
    const empty = join(sandbox, "empty-path");
    await mkdir(empty, { recursive: true });
    const failure = await launch([join(sandbox, "never")], [empty].join(delimiter)).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toContain("npm install -g pnpm");
    expect(failure?.stdout).toContain("npx @buildproven/wanderpage");
    await expect(stat(join(sandbox, "never"))).rejects.toThrow();
  });
});
