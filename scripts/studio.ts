#!/usr/bin/env node
// @design DES-CLI-LAUNCH
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { runStaticExport } from "@/lib/static-export-run";
import { createStudioServer } from "@/lib/studio/server";
import { loadStudioEnvironment } from "@/lib/studio/environment";

const root = process.cwd();
await loadStudioEnvironment(root);
const port = Number(process.env.WANDERPAGE_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WANDERPAGE_PORT must be a valid port number.");
const existingBuild = await stat(join(root, "out/studio.html"))
    .then(() => true)
    .catch(() => false),
  skipBuild = process.argv.includes("--no-build") && existingBuild;
if (!skipBuild) {
  console.log("Preparing Wanderpage Studio (the first launch builds the interface and takes about a minute)…");
  // Studio and the shareable site are the static export in out/; the hosted server build does not produce it.
  await runStaticExport(root);
}
const studio = createStudioServer({ root, port }),
  url = await studio.start();
console.log(`Wanderpage Studio is ready at ${url}`);
if (!process.argv.includes("--no-open")) studio.open();
const shutdown = async () => {
  await studio.stop();
  process.exitCode = 0;
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
