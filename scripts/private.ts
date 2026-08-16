#!/usr/bin/env node
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
  if (configuredFile) await loadEnvironmentFile(expandPath(configuredFile, root));
  else await loadFirstExisting([join(root, ".env"), join(root, ".env.local")]);
}

if (!process.env.OPENAI_API_KEY && input.isTTY && output.isTTY) {
  const readline = createInterface({ input, output });
  const answer = await readline.question(
    "Wanderpage needs OPENAI_API_KEY for real curation. Enter the path to your existing .env file (or press Return to cancel): "
  );
  readline.close();
  if (answer.trim()) await loadEnvironmentFile(expandPath(answer.trim(), root));
}

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "No OPENAI_API_KEY found. Put it in .env.local, set WANDERPAGE_ENV_FILE=/path/to/.env, or run pnpm trip:demo for the deterministic demo."
  );
  process.exitCode = 1;
} else {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["studio", ...process.argv.slice(2)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
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
}

async function loadFirstExisting(paths: string[]) {
  for (const filePath of paths) {
    if (
      await access(filePath)
        .then(() => true)
        .catch(() => false)
    ) {
      await loadEnvironmentFile(filePath);
      return;
    }
  }
}

function expandPath(value: string, rootDirectory: string) {
  const withHome = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(withHome) ? withHome : resolve(rootDirectory, withHome);
}
