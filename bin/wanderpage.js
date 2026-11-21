#!/usr/bin/env node
// @design DES-CLI-LAUNCH, DES-CLI-INSTALL
// Sets up a local Wanderpage project (like `create-next-app`) and launches Studio there. Studio writes generated trip data back into its own
// folder and needs its own node_modules, so it cannot run as a stateless, ephemeral `npx` package. This entry copies a light "local edition"
// of the package into a persistent project folder once, installs it with npm (which ships with Node, so nothing else has to be installed
// first), and starts Studio there on every run after.
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, localEdition, nodeVersionProblem, notCopied, shippedCodeFolders } from "./local-edition.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  args = process.argv.slice(2),
  commandNames = new Set(["inspect", "draft:list", "draft:show", "draft:validate", "draft:publish", "draft:unpublish"]),
  targetArg = args.find(arg => !arg.startsWith("--")),
  targetDir = resolve(targetArg ?? "./wanderpage"),
  skipOpen = args.includes("--no-open"),
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  // The version a new project records until its first install succeeds, so a failed first setup is finished on the next run.
  setupIncomplete = "0.0.0-setup-incomplete",
  // The files the launcher copied into the project, so a later refresh can remove the ones a newer version no longer ships.
  fileListName = ".wanderpage-files.json",
  // Written into node_modules only after npm install succeeds, so a partial install is never mistaken for a finished one.
  installedMarker = join("node_modules", ".wanderpage-installed"),
  // Kept in the project root (outside node_modules) from the start of npm install until it succeeds, so an interrupted install that left
  // every dependency folder in place is still finished on the next run.
  installPending = ".wanderpage-install-pending";

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

function runNpmInstall(cwd) {
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

async function npmInstall(cwd) {
  await writeFile(join(cwd, installPending), "");
  await rm(join(cwd, installedMarker), { force: true });
  await runNpmInstall(cwd);
  await writeFile(join(cwd, installedMarker), "");
  await rm(join(cwd, installPending), { force: true });
}

/**
 * Whether the project's dependencies are fully installed: no install is pending, and either npm finished under this launcher (the marker)
 * or, for a project an older launcher installed without the marker, every dependency its package.json names is present.
 */
async function dependenciesInstalled() {
  if (await pathExists(join(targetDir, installPending))) return false;
  if (await pathExists(join(targetDir, installedMarker))) return true;
  if (!(await pathExists(join(targetDir, "node_modules")))) return false;
  const manifest = await readFile(join(targetDir, "package.json"), "utf8")
    .then(text => JSON.parse(text))
    .catch(() => ({}));
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  for (const name of names) if (!(await pathExists(join(targetDir, "node_modules", name)))) return false;
  return true;
}

/** The package version in a project folder, or undefined when the folder is not a Wanderpage project (no readable package.json of ours). */
async function projectVersion(packageName) {
  try {
    const manifest = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
    return manifest.name === packageName && typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** The user's own files, which a refresh never writes or removes. */
const isUserOwned = relativePath =>
  relativePath === ".env.local" || relativePath === "data/trips" || relativePath.startsWith("data/trips/");

/** Every file under `root` (as `/`-separated relative paths), skipping the names that are never copied. */
async function listFiles(root, folder = "") {
  const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []),
    files = [];
  for (const entry of entries) {
    const relativePath = folder ? `${folder}/${entry.name}` : entry.name;
    if (notCopied.has(entry.name) || relativePath === "package.json") continue;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

/** The files a previous copy put into the project: its recorded list, or, for a project from an older launcher, its shipped code folders. */
async function previouslyShipped() {
  const recorded = await readFile(join(targetDir, fileListName), "utf8")
    .then(text => JSON.parse(text))
    .catch(() => undefined);
  if (Array.isArray(recorded)) return recorded.filter(path => typeof path === "string" && !path.split("/").includes(".."));
  return (await Promise.all(shippedCodeFolders.map(folder => listFiles(targetDir, folder)))).flat();
}

/**
 * Copies the shipped files into the project (package.json is written by writeManifest). On a refresh, the user's own files are never
 * touched, and files an earlier version shipped that this one no longer does are removed so stale code cannot break the build.
 */
async function copyEdition({ refresh }) {
  const shipped = await listFiles(packageRoot),
    owned = shipped.filter(path => !isUserOwned(path)),
    stale = refresh ? await previouslyShipped() : [];
  for (const relativePath of refresh ? owned : shipped) {
    await mkdir(dirname(join(targetDir, relativePath)), { recursive: true });
    await copyFile(join(packageRoot, relativePath), join(targetDir, relativePath));
  }
  const current = new Set(owned);
  for (const relativePath of stale)
    if (!current.has(relativePath) && !isUserOwned(relativePath)) await rm(join(targetDir, relativePath), { force: true });
  await writeFile(join(targetDir, fileListName), `${JSON.stringify(owned, null, 2)}\n`);
  await mkdir(join(targetDir, "data/trips"), { recursive: true });
}

/** Writes the project's package.json; `version` overrides the packaged version (used as a marker until the install succeeds). */
async function writeManifest(version) {
  const manifest = localEdition(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));
  await writeFile(join(targetDir, "package.json"), `${JSON.stringify({ ...manifest, version: version ?? manifest.version }, null, 2)}\n`);
}

/**
 * Installs the new dependencies, but records the packaged version only once npm succeeds. Until then package.json keeps `pendingVersion`,
 * so a failed install is retried on the next run instead of being mistaken for an up-to-date project.
 */
async function installEdition(pendingVersion) {
  await writeManifest(pendingVersion);
  await npmInstall(targetDir);
  await writeManifest();
  const envExample = join(targetDir, ".env.example"),
    envLocal = join(targetDir, ".env.local");
  if ((await pathExists(envExample)) && !(await pathExists(envLocal))) await cp(envExample, envLocal);
}

async function scaffold() {
  if (!(await isEmptyOrMissing(targetDir))) {
    console.log(`Using your existing Wanderpage project at ${targetDir}`);
    const packaged = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
      current = await projectVersion(packaged.name),
      order = current === undefined ? 0 : compareVersions(packaged.version, current);
    if (order > 0) {
      console.log(
        current === setupIncomplete
          ? "Its last setup did not finish, so finishing it now (about a minute)…"
          : `Updating it from version ${current} to ${packaged.version} (your trips and .env.local stay as they are)…`
      );
      await copyEdition({ refresh: true });
      await installEdition(current);
      return;
    }
    if (order < 0)
      console.log(
        `This project is version ${current}, newer than this launcher (${packaged.version}), so it is used as it is. For the newest launcher, run npx @buildproven/wanderpage@latest.`
      );
    if (!(await dependenciesInstalled())) {
      console.log("Its dependencies are missing, so installing them now (about a minute)…");
      await npmInstall(targetDir);
    }
    return;
  }

  console.log(`\n[1/3] Setting up your project in ${targetDir}`);
  await mkdir(targetDir, { recursive: true });
  await writeManifest(setupIncomplete);
  await copyEdition({ refresh: false });

  console.log("[2/3] Installing (about a minute, and only this once)…");
  await installEdition(setupIncomplete);
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
