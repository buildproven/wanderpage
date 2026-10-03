#!/usr/bin/env node
// @design DES-CLI-LAUNCH
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadEnvironmentFile, loadStudioEnvironment } from "@/lib/studio/environment";

const root = process.cwd();
await loadStudioEnvironment(root);

if (!process.env.OPENAI_API_KEY) {
  const configuredFile = process.env.WANDERPAGE_ENV_FILE;
  if (configuredFile) await loadEnvironmentFile(expandPath(configuredFile, root), { overrideEmpty: true });
  else await loadFirstExisting([join(root, ".env"), join(root, ".env.local")]);
}

if (!process.env.OPENAI_API_KEY && input.isTTY && output.isTTY) {
  const readline = createInterface({ input, output });
  const answer = await readline.question(
    "Wanderpage uses OPENAI_API_KEY for the full edit. Enter the path to your existing .env file (or press Return to continue with a basic edit): "
  );
  readline.close();
  if (answer.trim()) await loadEnvironmentFile(expandPath(answer.trim(), root), { overrideEmpty: true });
}

if (!process.env.OPENAI_API_KEY)
  console.log(
    "No OPENAI_API_KEY found, so Studio will make a basic edit (no AI captions, no people detection). Put the key in .env.local or set WANDERPAGE_ENV_FILE=/path/to/.env for the full edit."
  );
const child = spawn(
  process.execPath,
  [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/studio.ts"), ...process.argv.slice(2)],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }
);
child.once("error", error => {
  console.error(`Could not start Wanderpage Studio: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

async function loadFirstExisting(paths: string[]) {
  for (const filePath of paths) {
    if (
      await access(filePath)
        .then(() => true)
        .catch(() => false)
    ) {
      await loadEnvironmentFile(filePath, { overrideEmpty: true });
      return;
    }
  }
}

function expandPath(value: string, rootDirectory: string) {
  const withHome = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(withHome) ? withHome : resolve(rootDirectory, withHome);
}
