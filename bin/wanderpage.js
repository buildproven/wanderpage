#!/usr/bin/env node
// @design DES-CLI-LAUNCH
// Sets up a local Wanderpage project (like `create-next-app`) and launches Studio there. Studio writes generated trip data back into its own
// folder and needs its own node_modules, so it cannot run as a stateless, ephemeral `npx` package. This entry copies a light "local edition"
// of the package into a persistent project folder once, installs it with npm (which ships with Node, so nothing else has to be installed
// first), and starts Studio there on every run after.
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localEdition, nodeVersionProblem, notCopied } from "./local-edition.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  args = process.argv.slice(2),
  commandNames = new Set(["inspect", "draft:list", "draft:show", "draft:validate", "draft:publish", "draft:unpublish"]),
  targetArg = args.find(arg => !arg.startsWith("--")),
  targetDir = resolve(targetArg ?? "./wanderpage"),
  skipOpen = args.includes("--no-open"),
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function pathExists(path) {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

async function isEmptyOrMissing(path) {
  if (!(await pathExists(path))) return true;
  const entries = await readdir(path);
  return entries.length === 0;
}

function npmInstall(cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npmCommand, ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise(undefined);
      else
        reject(new Error(`npm install exited with code ${code ?? signal}. Check your internet connection and run the same command again.`));
    });
  });
}

async function scaffold() {
  if (!(await isEmptyOrMissing(targetDir))) {
    console.log(`Using your existing Wanderpage project at ${targetDir}`);
    if (!(await pathExists(join(targetDir, "node_modules")))) {
      console.log("Its dependencies are missing, so installing them now (about a minute)…");
      await npmInstall(targetDir);
    }
    return;
  }

  console.log(`\n[1/3] Setting up your project in ${targetDir}`);
  await mkdir(targetDir, { recursive: true });
  await cp(packageRoot, targetDir, {
    recursive: true,
    filter: source => {
      const relativePath = source.slice(packageRoot.length + 1);
      return !relativePath.split(/[\\/]/).some(segment => notCopied.has(segment));
    },
  });
  const manifest = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
  await writeFile(join(targetDir, "package.json"), `${JSON.stringify(localEdition(manifest), null, 2)}\n`);
  await mkdir(join(targetDir, "data/trips"), { recursive: true });

  console.log("[2/3] Installing (about a minute, and only this once)…");
  await npmInstall(targetDir);

  const envExample = join(targetDir, ".env.example"),
    envLocal = join(targetDir, ".env.local");
  if ((await pathExists(envExample)) && !(await pathExists(envLocal))) await cp(envExample, envLocal);
}

async function launchStudio() {
  console.log("[3/3] Starting Studio (the first launch builds the interface, about 30 seconds)…");
  if (!process.env.OPENAI_API_KEY) {
    console.log(
      "\nNo OPENAI_API_KEY found, so Wanderpage will make a basic edit (photos ranked by quality, no AI captions, no people detection)."
    );
    console.log(`For the full edit, add your key to ${join(targetDir, ".env.local")} and run this command again.\n`);
  }
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(targetDir, "node_modules/tsx/dist/cli.mjs"), "scripts/studio.ts", ...(skipOpen ? ["--no-open"] : [])],
      {
        cwd: targetDir,
        stdio: "inherit",
        env: process.env,
      }
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") resolvePromise(undefined);
      else reject(new Error(`Studio exited with code ${code ?? signal}`));
    });
  });
}

async function runCommand() {
  // Agent commands only need the packaged tsx, not pnpm or a project, so they work from any directory.
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(packageRoot, "scripts", "wanderpage.ts"), ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: { ...process.env, TSX_TSCONFIG_PATH: join(packageRoot, "tsconfig.json") },
    });
    child.on("exit", (code, signal) =>
      code === 0
        ? resolvePromise(undefined)
        : reject(Object.assign(new Error(`wanderpage command exited with code ${code ?? signal}`), { exitCode: code ?? 1 }))
    );
  });
}

const nodeProblem = nodeVersionProblem(process.versions.node);
if (nodeProblem) {
  console.error(`\n${nodeProblem}`);
  process.exit(1);
}

try {
  if (commandNames.has(args[0] ?? "")) {
    await runCommand();
    process.exit(0);
  }
  await scaffold();
  await launchStudio();
} catch (error) {
  if (error && typeof error === "object" && "exitCode" in error && commandNames.has(args[0] ?? "")) process.exit(Number(error.exitCode));
  console.error(`\nWanderpage could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
