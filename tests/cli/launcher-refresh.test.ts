import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

const manifestFor = (version: string, name = "fake-wanderpage") =>
  JSON.stringify({
    name,
    version,
    type: "module",
    scripts: { studio: "tsx scripts/studio.ts", mcp: "tsx mcp/server.ts" },
    dependencies: { tsx: "^4.0.0" },
  });

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-refresh-"));
  packageDir = join(sandbox, "package");
  shimDir = join(sandbox, "shim");
  log = join(sandbox, "npm.log");
  for (const folder of ["bin", "mcp", "data/trips", "node_modules/should-not-copy"])
    await mkdir(join(packageDir, folder), { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await cp(join(repoRoot, "bin/wanderpage.js"), join(packageDir, "bin/wanderpage.js"));
  await cp(join(repoRoot, "bin/local-edition.js"), join(packageDir, "bin/local-edition.js"));
  await writeFile(join(packageDir, "package.json"), manifestFor("2.0.0"));
  await writeFile(join(packageDir, "mcp/server.ts"), "export const server = 2;\n");
  await writeFile(join(packageDir, "data/trips/.gitkeep"), "");
  await writeFile(join(packageDir, ".env.example"), "OPENAI_API_KEY=\n");
  await writeFile(
    join(shimDir, "npm"),
    `#!/bin/sh\necho "$@" >> "${log}"\n/bin/mkdir -p node_modules/tsx/dist\necho 'console.log("studio-started")' > node_modules/tsx/dist/cli.mjs\nexit 0\n`
  );
  await chmod(join(shimDir, "npm"), 0o755);
});
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});

const launch = (target: string) =>
  execute(process.execPath, [join(packageDir, "bin/wanderpage.js"), target, "--no-open"], {
    env: { ...process.env, PATH: `${shimDir}:${dirname(process.execPath)}`, OPENAI_API_KEY: "" },
  });
const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
const exists = (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);

async function oldProject(name: string, version = "1.0.0", packageName = "fake-wanderpage") {
  const target = join(sandbox, name);
  await mkdir(join(target, "node_modules/tsx/dist"), { recursive: true });
  await mkdir(join(target, "data/trips/my-trip"), { recursive: true });
  await mkdir(join(target, "scripts"), { recursive: true });
  await writeFile(join(target, "node_modules/tsx/dist/cli.mjs"), 'console.log("studio-started")');
  await writeFile(join(target, "package.json"), manifestFor(version, packageName));
  await writeFile(join(target, "data/trips/my-trip/trip.json"), '{"mine":true}');
  await writeFile(join(target, ".env.local"), "OPENAI_API_KEY=sk-mine\n");
  await writeFile(join(target, "scripts/studio.ts"), "// old studio\n");
  await writeFile(log, "");
  return target;
}

// @verifies DES-CLI-LAUNCH, REQ-CLI-01
describe("re-running the launcher on an existing project", () => {
  it("refreshes a project from an older version: new files arrive, the manifest updates, and dependencies reinstall", async () => {
    const target = await oldProject("older");
    expect(await exists(join(target, "mcp/server.ts"))).toBe(false);
    const { stdout } = await launch(target);
    expect(stdout).toContain("Updating it from version 1.0.0 to 2.0.0");
    expect(await readFile(join(target, "mcp/server.ts"), "utf8")).toBe("export const server = 2;\n");
    expect(JSON.parse(await readFile(join(target, "package.json"), "utf8")).version).toBe("2.0.0");
    expect(await calls()).toEqual(["install --no-audit --no-fund --loglevel=error"]);
    expect(stdout).toContain("studio-started");
  });

  it("never overwrites the user's trips or .env.local, and does not copy skipped folders", async () => {
    const target = await oldProject("keeps-data");
    await launch(target);
    expect(await readFile(join(target, "data/trips/my-trip/trip.json"), "utf8")).toBe('{"mine":true}');
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("OPENAI_API_KEY=sk-mine\n");
    expect(await exists(join(target, "node_modules/should-not-copy"))).toBe(false);
    expect(await exists(join(target, "data/trips/.gitkeep"))).toBe(false);
  });

  it("reuses a project that is already on this version without copying or reinstalling", async () => {
    const target = await oldProject("current", "2.0.0");
    const { stdout } = await launch(target);
    expect(stdout).toContain("Using your existing Wanderpage project");
    expect(stdout).not.toContain("Updating it");
    expect(await exists(join(target, "mcp/server.ts"))).toBe(false);
    expect(await calls()).toEqual([]);
  });

  it("leaves a folder that is not a Wanderpage project alone", async () => {
    const target = await oldProject("someone-elses", "1.0.0", "some-other-app");
    await launch(target);
    expect(await exists(join(target, "mcp/server.ts"))).toBe(false);
    expect(JSON.parse(await readFile(join(target, "package.json"), "utf8")).name).toBe("some-other-app");
    expect(await calls()).toEqual([]);
  });

  it("stops with a clear message when the dependency install fails during a refresh", async () => {
    const target = await oldProject("install-fails");
    await writeFile(join(shimDir, "npm"), "#!/bin/sh\nexit 1\n");
    try {
      await expect(launch(target)).rejects.toMatchObject({ stderr: expect.stringContaining("npm install exited with code 1") });
    } finally {
      await writeFile(
        join(shimDir, "npm"),
        `#!/bin/sh\necho "$@" >> "${log}"\n/bin/mkdir -p node_modules/tsx/dist\necho 'console.log("studio-started")' > node_modules/tsx/dist/cli.mjs\nexit 0\n`
      );
    }
  });
});
