#!/usr/bin/env node
// Scaffolds a local Wanderpage project (like `create-next-app`) and launches Studio there.
// Studio is a full local app — it runs `pnpm build`, writes generated trip data back into
// its own folder, and needs its own node_modules — so it cannot run as a stateless,
// ephemeral `npx` package. This entry copies the package into a persistent project
// directory once, then delegates to the existing `pnpm studio` flow on every run after.
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile),
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  args = process.argv.slice(2),
  targetArg = args.find(arg => !arg.startsWith("--")),
  targetDir = resolve(targetArg ?? "./wanderpage"),
  skipOpen = args.includes("--no-open");

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

function checkCommand(command) {
  return execute(command, ["--version"]).then(
    () => true,
    () => false
  );
}

async function scaffold() {
  if (!(await isEmptyOrMissing(targetDir))) {
    console.log(`Using existing Wanderpage project at ${targetDir}`);
    return;
  }
  console.log(`Creating a new Wanderpage project at ${targetDir}...`);
  await mkdir(targetDir, { recursive: true });
  const skip = new Set([
    "node_modules",
    ".next",
    "out",
    ".git",
    ".trip-cache",
    ".trip-output",
    ".vercel",
    ".claude-kit",
    ".github",
    ".husky",
    ".gitmodules",
  ]);
  await cp(packageRoot, targetDir, {
    recursive: true,
    filter: source => {
      const relativePath = source.slice(packageRoot.length + 1).split("/")[0];
      return !skip.has(relativePath);
    },
  });
  await mkdir(join(targetDir, "data/trips"), { recursive: true });

  const hasPnpm = await checkCommand("pnpm");
  if (!hasPnpm) {
    console.log("\nWanderpage needs pnpm once before it can run.");
    console.log("Install it with: npm install -g pnpm");
    console.log(`Then run: cd ${targetDir} && pnpm install && pnpm studio`);
    process.exit(1);
  }

  console.log("Installing dependencies (this happens once)...");
  await execute("pnpm", ["install"], { cwd: targetDir, maxBuffer: 20_000_000 });

  const envExample = join(targetDir, ".env.example"),
    envLocal = join(targetDir, ".env.local");
  if ((await pathExists(envExample)) && !(await pathExists(envLocal))) {
    await cp(envExample, envLocal);
  }
}

async function launchStudio() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("\nNo OPENAI_API_KEY found. Studio will open, but you'll need a key for real photo analysis and narrative generation.");
    console.log(`Add it to ${join(targetDir, ".env.local")} or set it in your shell before running again.\n`);
  }

  const pnpmArgs = ["studio", ...(skipOpen ? ["--", "--no-open"] : [])];
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", pnpmArgs, {
      cwd: targetDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", code => (code === 0 ? resolvePromise(undefined) : reject(new Error(`Studio exited with code ${code}`))));
  });
}

try {
  await scaffold();
  await launchStudio();
} catch (error) {
  console.error(`\nWanderpage failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
