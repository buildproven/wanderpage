import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareVersions } from "../../bin/local-edition.js";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
let sandbox = "",
  shimDir = "",
  log = "";

const manifestFor = (version: string, dependencies: Record<string, string> = { tsx: "^4.0.0" }) =>
  JSON.stringify({ name: "fake-wanderpage", version, type: "module", scripts: { studio: "tsx scripts/studio.ts" }, dependencies });

// A stand-in npm that installs one folder per dependency name it is told about, or fails partway like an interrupted download.
async function useNpm(works: boolean, { partial = false } = {}) {
  const unpack = `/bin/mkdir -p node_modules/tsx/dist node_modules/new-dependency\necho 'console.log("studio-started")' > node_modules/tsx/dist/cli.mjs`;
  const body = works ? `echo "$@" >> "${log}"\n${unpack}\nexit 0` : `echo "failed $@" >> "${log}"\n${partial ? unpack : ""}\nexit 1`;
  await writeFile(join(shimDir, "npm"), `#!/bin/sh\n${body}\n`);
  await chmod(join(shimDir, "npm"), 0o755);
}

/** A fake published package at `version` that ships the given files. */
async function makePackage(version: string, files: Record<string, string>, dependencies?: Record<string, string>) {
  const packageDir = join(sandbox, `package-${version}`);
  await mkdir(join(packageDir, "bin"), { recursive: true });
  await cp(join(repoRoot, "bin/wanderpage.js"), join(packageDir, "bin/wanderpage.js"));
  await cp(join(repoRoot, "bin/local-edition.js"), join(packageDir, "bin/local-edition.js"));
  await writeFile(join(packageDir, "package.json"), manifestFor(version, dependencies));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(packageDir, path)), { recursive: true });
    await writeFile(join(packageDir, path), content);
  }
  return packageDir;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-upgrade-"));
  shimDir = join(sandbox, "shim");
  log = join(sandbox, "npm.log");
  await mkdir(shimDir, { recursive: true });
  await useNpm(true);
});
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});

const launch = (packageDir: string, target: string) =>
  execute(process.execPath, [join(packageDir, "bin/wanderpage.js"), target, "--no-open"], {
    env: { ...process.env, PATH: `${shimDir}:${dirname(process.execPath)}`, OPENAI_API_KEY: "" },
  });
const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
const exists = (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);
const version = async (target: string) => (JSON.parse(await readFile(join(target, "package.json"), "utf8")) as { version: string }).version;

async function installedProject(name: string, projectVersion: string, dependencies?: Record<string, string>) {
  const target = join(sandbox, name);
  await mkdir(join(target, "node_modules/tsx/dist"), { recursive: true });
  await writeFile(join(target, "node_modules/tsx/dist/cli.mjs"), 'console.log("studio-started")');
  await writeFile(join(target, "package.json"), manifestFor(projectVersion, dependencies));
  await writeFile(log, "");
  return target;
}

// @verifies DES-CLI-LAUNCH, REQ-CLI-01
describe("version order", () => {
  it("orders releases numerically and puts a pre-release before its release", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.0.0-setup-incomplete")).toBeGreaterThan(0);
  });
});

// @verifies DES-CLI-LAUNCH, REQ-CLI-01
describe("an older launcher never downgrades a project", () => {
  it("uses a newer project as it is and says how to get the newest launcher", async () => {
    const packageDir = await makePackage("2.0.0", { "mcp/server.ts": "export const from = 2;\n" }),
      target = await installedProject("newer-project", "3.0.0");
    const { stdout } = await launch(packageDir, target);
    expect(stdout).toContain("This project is version 3.0.0, newer than this launcher (2.0.0)");
    expect(stdout).toContain("npx @buildproven/wanderpage@latest");
    expect(stdout).not.toContain("Updating it");
    expect(await exists(join(target, "mcp/server.ts"))).toBe(false);
    expect(await version(target)).toBe("3.0.0");
    expect(await calls()).toEqual([]);
    expect(stdout).toContain("studio-started");
  });
});

// @verifies DES-CLI-LAUNCH, REQ-CLI-01
describe("a refresh removes files the new version no longer ships", () => {
  it("removes the files the earlier launcher recorded but the new version dropped, and keeps the user's trips and generated pages", async () => {
    const first = await makePackage("1.0.0", { "lib/old.ts": "import './gone';\n", "lib/keep.ts": "v1\n" }),
      second = await makePackage("1.1.0", { "lib/keep.ts": "v2\n", "lib/new.ts": "new\n" }),
      target = join(sandbox, "recorded");
    await writeFile(log, "");
    await launch(first, target);
    await mkdir(join(target, "data/trips/mine"), { recursive: true });
    await writeFile(join(target, "data/trips/mine/trip.json"), "{}");
    await mkdir(join(target, "public/trip/generated"), { recursive: true });
    await writeFile(join(target, "public/trip/generated/photo.jpg"), "jpg");

    const { stdout } = await launch(second, target);
    expect(stdout).toContain("Updating it from version 1.0.0 to 1.1.0");
    expect(await exists(join(target, "lib/old.ts"))).toBe(false);
    expect(await readFile(join(target, "lib/keep.ts"), "utf8")).toBe("v2\n");
    expect(await readFile(join(target, "lib/new.ts"), "utf8")).toBe("new\n");
    expect(await readFile(join(target, "data/trips/mine/trip.json"), "utf8")).toBe("{}");
    expect(await readFile(join(target, "public/trip/generated/photo.jpg"), "utf8")).toBe("jpg");
  });

  it("prunes only the shipped code folders of a project from a launcher that kept no file list", async () => {
    const packageDir = await makePackage("1.1.0", { "lib/keep.ts": "v2\n" }),
      target = await installedProject("legacy-list", "1.0.0");
    await mkdir(join(target, "lib"), { recursive: true });
    await writeFile(join(target, "lib/stale.ts"), "import './removed';\n");
    await mkdir(join(target, "data/trips/mine"), { recursive: true });
    await writeFile(join(target, "data/trips/mine/trip.json"), "{}");
    await mkdir(join(target, "public/trip/generated"), { recursive: true });
    await writeFile(join(target, "public/trip/generated/photo.jpg"), "jpg");
    await writeFile(join(target, ".env.local"), "OPENAI_API_KEY=sk-mine\n");
    await writeFile(join(target, "notes.txt"), "mine\n");

    await launch(packageDir, target);
    expect(await exists(join(target, "lib/stale.ts"))).toBe(false);
    expect(await readFile(join(target, "lib/keep.ts"), "utf8")).toBe("v2\n");
    expect(await readFile(join(target, "data/trips/mine/trip.json"), "utf8")).toBe("{}");
    expect(await readFile(join(target, "public/trip/generated/photo.jpg"), "utf8")).toBe("jpg");
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("OPENAI_API_KEY=sk-mine\n");
    expect(await readFile(join(target, "notes.txt"), "utf8")).toBe("mine\n");
  });

  it("ignores a recorded path that would leave the project folder", async () => {
    const packageDir = await makePackage("1.1.0", { "lib/keep.ts": "v2\n" }),
      target = await installedProject("escaping-list", "1.0.0"),
      outside = join(sandbox, "outside.txt");
    await writeFile(outside, "keep me\n");
    await writeFile(join(target, ".wanderpage-files.json"), JSON.stringify(["../outside.txt", 7]));
    await launch(packageDir, target);
    expect(await readFile(outside, "utf8")).toBe("keep me\n");
  });
});

// @verifies DES-CLI-LAUNCH, REQ-CLI-01
describe("a project on the current version with an unfinished install", () => {
  const dependencies = { tsx: "^4.0.0", "new-dependency": "^1.0.0" };

  it("reinstalls when a dependency is missing, retries after a failed reinstall, and then stops reinstalling", async () => {
    const packageDir = await makePackage("2.0.0", {}, dependencies),
      target = await installedProject("partial-modules", "2.0.0", dependencies);

    await useNpm(false);
    await expect(launch(packageDir, target)).rejects.toMatchObject({ stderr: expect.stringContaining("npm install exited with code 1") });
    await useNpm(true);
    const { stdout } = await launch(packageDir, target);
    expect(stdout).toContain("Its dependencies are missing");
    expect(stdout).toContain("studio-started");
    await launch(packageDir, target);
    expect(await calls()).toEqual([
      "failed install --no-audit --no-fund --loglevel=error",
      "install --no-audit --no-fund --loglevel=error",
    ]);
  });

  it("does not trust an install that npm did not finish, even when it left every dependency folder in place", async () => {
    const packageDir = await makePackage("2.0.0", {}, dependencies),
      target = join(sandbox, "interrupted");
    await writeFile(log, "");
    // The user deleted node_modules; the reinstall unpacks every package and then fails.
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "package.json"), manifestFor("2.0.0", dependencies));
    await useNpm(false, { partial: true });
    await expect(launch(packageDir, target)).rejects.toMatchObject({ stderr: expect.stringContaining("npm install exited with code 1") });
    expect(await exists(join(target, "node_modules/new-dependency"))).toBe(true);

    await useNpm(true);
    const { stdout } = await launch(packageDir, target);
    expect(stdout).toContain("Its dependencies are missing");
    expect(await exists(join(target, ".wanderpage-install-pending"))).toBe(false);
    await launch(packageDir, target);
    expect(await calls()).toEqual([
      "failed install --no-audit --no-fund --loglevel=error",
      "install --no-audit --no-fund --loglevel=error",
    ]);
  });
});
