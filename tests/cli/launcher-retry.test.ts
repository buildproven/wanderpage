import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
let sandbox = "",
  packageDir = "",
  shimDir = "",
  log = "";

const manifestFor = (version: string, dependencies: Record<string, string>) =>
  JSON.stringify({ name: "fake-wanderpage", version, type: "module", scripts: { studio: "tsx scripts/studio.ts" }, dependencies });

// A stand-in npm that "installs" a tsx entry point, or one that fails the way an interrupted download does.
async function useNpm(works: boolean) {
  const body = works
    ? `echo "$@" >> "${log}"\n/bin/mkdir -p node_modules/tsx/dist\necho 'console.log("studio-started")' > node_modules/tsx/dist/cli.mjs\nexit 0`
    : `echo "failed $@" >> "${log}"\n/bin/mkdir -p node_modules/partial\nexit 1`;
  await writeFile(join(shimDir, "npm"), `#!/bin/sh\n${body}\n`);
  await chmod(join(shimDir, "npm"), 0o755);
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-retry-"));
  packageDir = join(sandbox, "package");
  shimDir = join(sandbox, "shim");
  log = join(sandbox, "npm.log");
  for (const folder of ["bin", "mcp"]) await mkdir(join(packageDir, folder), { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await cp(join(repoRoot, "bin/wanderpage.js"), join(packageDir, "bin/wanderpage.js"));
  await cp(join(repoRoot, "bin/local-edition.js"), join(packageDir, "bin/local-edition.js"));
  await writeFile(join(packageDir, "package.json"), manifestFor("2.0.0", { tsx: "^4.0.0", "new-dependency": "^1.0.0" }));
  await writeFile(join(packageDir, "mcp/server.ts"), "export {};\n");
  await writeFile(join(packageDir, ".env.example"), "OPENAI_API_KEY=\n");
});
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});

const launch = (target: string) =>
  execute(process.execPath, [join(packageDir, "bin/wanderpage.js"), target, "--no-open"], {
    env: { ...process.env, PATH: `${shimDir}:${dirname(process.execPath)}`, OPENAI_API_KEY: "" },
  });
const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
const manifest = async (target: string) =>
  JSON.parse(await readFile(join(target, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };

// @verifies DES-CLI-LAUNCH, REQ-CLI-01
describe("a failed install is retried on the next run", () => {
  it("keeps the old version after a failed refresh install, so running the same command again installs the new dependencies", async () => {
    const target = join(sandbox, "refresh-fails");
    await mkdir(join(target, "node_modules/tsx/dist"), { recursive: true });
    await writeFile(join(target, "node_modules/tsx/dist/cli.mjs"), 'console.log("studio-started")');
    await writeFile(join(target, "package.json"), manifestFor("1.0.0", { tsx: "^4.0.0" }));
    await writeFile(log, "");

    await useNpm(false);
    await expect(launch(target)).rejects.toMatchObject({ stderr: expect.stringContaining("npm install exited with code 1") });
    const afterFailure = await manifest(target);
    expect(afterFailure.version).toBe("1.0.0");
    expect(afterFailure.dependencies).toHaveProperty("new-dependency");

    await useNpm(true);
    const { stdout } = await launch(target);
    expect(stdout).toContain("Updating it from version 1.0.0 to 2.0.0");
    expect(stdout).toContain("studio-started");
    expect((await manifest(target)).version).toBe("2.0.0");
    expect(await calls()).toEqual([
      "failed install --no-audit --no-fund --loglevel=error",
      "install --no-audit --no-fund --loglevel=error",
    ]);
  });

  it("finishes a first setup whose install failed instead of starting Studio without its dependencies", async () => {
    const target = join(sandbox, "first-setup-fails");
    await writeFile(log, "");

    await useNpm(false);
    await expect(launch(target)).rejects.toMatchObject({ stderr: expect.stringContaining("npm install exited with code 1") });
    expect((await manifest(target)).version).toBe("0.0.0-setup-incomplete");

    await useNpm(true);
    const { stdout } = await launch(target);
    expect(stdout).toContain("Its last setup did not finish");
    expect(stdout).toContain("studio-started");
    expect((await manifest(target)).version).toBe("2.0.0");
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("OPENAI_API_KEY=\n");
    expect(await calls()).toEqual([
      "failed install --no-audit --no-fund --loglevel=error",
      "install --no-audit --no-fund --loglevel=error",
    ]);
  });

  it("does not reinstall once the install has succeeded", async () => {
    const target = join(sandbox, "first-setup-fails");
    await writeFile(log, "");
    const { stdout } = await launch(target);
    expect(stdout).not.toContain("Updating it");
    expect(await calls()).toEqual([]);
  });
});
