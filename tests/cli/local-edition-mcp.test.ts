import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localEdition, notCopied } from "../../bin/local-edition.js";
import { repoRoot } from "../helpers/workspace";

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Parameters<typeof localEdition>[0] & {
  files: string[];
  scripts: Record<string, string>;
};
const local = localEdition(pkg);
const installed = new Set([...Object.keys(local.dependencies), ...Object.keys(local.devDependencies)]);

function packagesImportedBy(source: string) {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("node:")) continue;
    const [first, second] = specifier.split("/");
    const name = specifier.startsWith("@") ? `${first}/${second}` : first!;
    if (!builtinModules.includes(name)) found.add(name);
  }
  return found;
}

// BUI-1909: a project made by `npx @buildproven/wanderpage` can start the local MCP server with `npm run mcp`.
// @verifies DES-CLI-LAUNCH, REQ-MCP-1
describe("BUI-1909 the local edition can run the MCP server", () => {
  it("BUI-1909 keeps the mcp script unchanged in the user's package.json", () => {
    expect(pkg.scripts.mcp).toBeDefined();
    expect(local.scripts).toHaveProperty("mcp", pkg.scripts.mcp);
  });

  it("BUI-1909 omits the mcp script when the package has none", () => {
    expect(localEdition({ ...pkg, scripts: { studio: "tsx scripts/studio.ts" } }).scripts).toEqual({ studio: "tsx scripts/studio.ts" });
  });

  it("BUI-1909 ships and copies the mcp folder, and installs what its server imports", () => {
    expect(pkg.files).toContain("mcp");
    expect(notCopied.has("mcp")).toBe(false);
    const runner = pkg.scripts.mcp!.split(" ")[0]!;
    expect(installed.has(runner)).toBe(true);
    const sources = readdirSync(join(repoRoot, "mcp")).filter(name => /\.(ts|js|mjs)$/.test(name) && !/\.test\./.test(name));
    expect(sources).toContain("server.ts");
    const missing = sources.flatMap(name =>
      [...packagesImportedBy(readFileSync(join(repoRoot, "mcp", name), "utf8"))]
        .filter(dep => !installed.has(dep))
        .map(dep => `${name} -> ${dep}`)
    );
    expect(missing).toEqual([]);
  });
});
