import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localEdition, nodeVersionProblem } from "../../bin/local-edition.js";
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
  log = join(sandbox, "npm.log");
  for (const folder of ["bin", "data", "db", "workflows", "app", "node_modules/should-not-copy"])
    await mkdir(join(packageDir, folder), { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await cp(join(repoRoot, "bin/wanderpage.js"), join(packageDir, "bin/wanderpage.js"));
  await cp(join(repoRoot, "bin/local-edition.js"), join(packageDir, "bin/local-edition.js"));
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "fake-wanderpage",
      version: "9.9.9",
      type: "module",
      scripts: { studio: "tsx scripts/studio.ts", lint: "eslint .", prepare: "husky" },
      dependencies: { next: "^16.0.0", workflow: "4.0.0", "@vercel/blob": "2.0.0", tsx: "^4.0.0" },
      devDependencies: { vitest: "^5.0.0", typescript: "^5.0.0", "@lhci/cli": "^0.14.0" },
    })
  );
  await writeFile(join(packageDir, ".env.example"), "OPENAI_API_KEY=\n");
  await writeFile(join(packageDir, "pnpm-workspace.yaml"), "overrides: {}\n");
  await writeFile(join(packageDir, "proxy.ts"), "export {}\n");
  await writeFile(join(packageDir, "data/trip.demo.json"), "{}\n");
  // A stand-in npm: records its arguments and "installs" a tsx whose entry point just reports how it was started.
  await writeFile(
    join(shimDir, "npm"),
    `#!/bin/sh\necho "$@" >> "${log}"\n/bin/mkdir -p node_modules/tsx/dist\necho 'console.log("studio-started " + process.argv.slice(2).join(" "))' > node_modules/tsx/dist/cli.mjs\nexit 0\n`
  );
  await chmod(join(shimDir, "npm"), 0o755);
});
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});

// Only node and the stand-in npm are on PATH: there is no pnpm, git, or anything else to lean on.
const launch = (args: string[]) =>
  execute(process.execPath, [join(packageDir, "bin/wanderpage.js"), ...args], {
    env: { ...process.env, PATH: `${shimDir}:${dirname(process.execPath)}`, OPENAI_API_KEY: "" },
  });
const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);

// @verifies DES-CLI-LAUNCH, ARCH-CLI, REQ-CLI-01, REQ-CLI-06, SN-06
describe("one-command launcher", () => {
  it("sets up a light project with only Node and npm, installs once, seeds the env file, and starts Studio", async () => {
    const target = join(sandbox, "my-trips"),
      { stdout } = await launch([target, "--no-open"]);
    expect(stdout).toMatch(/\[1\/3\] Setting up your project/);
    expect(stdout).toMatch(/\[2\/3\] Installing/);
    expect(stdout).toMatch(/\[3\/3\] Starting Studio/);
    expect(stdout).toContain("No OPENAI_API_KEY found");
    expect(stdout).toContain("studio-started scripts/studio.ts --no-open");
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("OPENAI_API_KEY=\n");
    expect((await stat(join(target, "data/trips"))).isDirectory()).toBe(true);
    for (const leftBehind of ["db", "workflows", "proxy.ts", "pnpm-workspace.yaml", "node_modules/should-not-copy"])
      await expect(stat(join(target, leftBehind)), `${leftBehind} must not be copied`).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    expect(Object.keys(manifest.dependencies!).sort()).toEqual(["next", "tsx"]);
    expect(Object.keys(manifest.devDependencies!)).toEqual(["typescript"]);
    expect(Object.keys(manifest.scripts!)).toEqual(["studio"]);
    expect(await calls()).toEqual(["install --no-audit --no-fund --loglevel=error"]);
  });

  it("relaunches an existing project without reinstalling", async () => {
    const target = join(sandbox, "existing");
    await mkdir(join(target, "node_modules/tsx/dist"), { recursive: true });
    await writeFile(join(target, "node_modules/tsx/dist/cli.mjs"), 'console.log("studio-started again")');
    await writeFile(join(target, "package.json"), "{}");
    await writeFile(log, "");
    const { stdout } = await launch([target, "--no-open"]);
    expect(stdout).toContain("Using your existing Wanderpage project");
    expect(stdout).toContain("studio-started again");
    expect(await calls()).toEqual([]);
  });
});

// @verifies DES-CLI-LAUNCH, REQ-CLI-01
describe("prerequisite check", () => {
  it("explains an old Node.js in plain words and accepts the supported ones", () => {
    expect(nodeVersionProblem("22.11.0")).toContain("needs Node.js 24 or newer, and this is Node.js 22.11.0");
    expect(nodeVersionProblem("22.11.0")).toContain("https://nodejs.org");
    expect(nodeVersionProblem("24.18.0")).toBeUndefined();
    expect(nodeVersionProblem("26.0.1")).toBeUndefined();
  });
});

// @verifies DES-CLI-LAUNCH, ARCH-CLI, REQ-CLI-06, SN-06
describe("local edition of the package", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Parameters<typeof localEdition>[0];

  it("keeps only what making trip pages needs: no test, lint, browser-automation, or hosted-service packages", () => {
    const local = localEdition(pkg);
    expect(Object.keys(local.devDependencies).sort()).toEqual(["@types/node", "@types/react", "@types/react-dom", "typescript"]);
    for (const hosted of ["workflow", "@workflow/next", "@neondatabase/serverless", "@vercel/blob"])
      expect(local.dependencies).not.toHaveProperty(hosted);
    for (const needed of ["next", "react", "react-dom", "sharp", "tsx", "serve", "openai", "zod", "exifr", "commander"])
      expect(local.dependencies).toHaveProperty(needed);
    expect(Object.keys(local.scripts)).toEqual(expect.arrayContaining(["studio", "trip", "static:export", "preview:static", "wanderpage"]));
    expect(Object.keys(local.scripts)).not.toEqual(expect.arrayContaining(["test", "lint", "prepare"]));
    expect(Object.keys(local.dependencies).length + Object.keys(local.devDependencies).length).toBeLessThan(20);
  });
});
