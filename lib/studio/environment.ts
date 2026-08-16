import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadStudioEnvironment(root: string) {
  await loadEnvironmentFile(join(root, ".env.local"));
}

/**
 * Load a dotenv-style file without replacing values already supplied by the shell.
 * This is intentionally small: Studio only needs the simple KEY=value format used
 * by the generated project and a user's existing private env file.
 */
export async function loadEnvironmentFile(filePath: string, options: { overrideEmpty?: boolean } = {}) {
  const content = await readFile(filePath, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!content) return false;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const existing = process.env[match[1]!];
    if (existing !== undefined && !(options.overrideEmpty && existing === "")) continue;
    process.env[match[1]!] = parseValue(match[2]!);
  }
  return true;
}

function parseValue(value: string) {
  const trimmed = value.trim();
  const quote = trimmed.at(0);
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "").trim();
}
