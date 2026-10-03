// @design DES-PUB-EXPORT
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Builds the shareable static site into `out/` with the project's own tsx, so no package manager has to be installed or on PATH. */
export async function runStaticExport(root: string) {
  const tsx = createRequire(join(root, "package.json")).resolve("tsx/cli");
  await execute(process.execPath, [tsx, join(root, "scripts/static-export.ts")], { cwd: root, maxBuffer: 10_000_000 });
}
