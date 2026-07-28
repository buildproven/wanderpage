import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadStudioEnvironment(root: string) {
  const content = await readFile(join(root, ".env.local"), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!content) return;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]!] !== undefined) continue;
    process.env[match[1]!] = parseValue(match[2]!);
  }
}

function parseValue(value: string) {
  const trimmed = value.trim();
  const quote = trimmed.at(0);
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "").trim();
}
