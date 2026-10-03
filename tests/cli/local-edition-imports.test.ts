import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { localEdition } from "../../bin/local-edition.js";
import { repoRoot } from "../helpers/workspace";

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Parameters<typeof localEdition>[0];
const local = localEdition(pkg);
const installed = new Set([...Object.keys(local.dependencies), ...Object.keys(local.devDependencies)]);

// Mirrors what the launcher copies and what scripts/static-export.ts strips for the user's project.
const hostedOnly = [
  /^app\/(api|create|stories|s|\.well-known)\//,
  /^app\/trips\/\[slug\]\//,
  /^components\/(WebCreator|DraftControls)/,
  /^lib\/web\//,
  /^scripts\/(hosted-preview-acceptance|release-|trace)/,
  /\.test\.tsx?$/,
];
const roots = ["app", "assets", "bin", "components", "lib", "scripts"];

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const shipped = roots
  .flatMap(root => walk(join(repoRoot, root)))
  .map(path => relative(repoRoot, path))
  .filter(path => !hostedOnly.some(pattern => pattern.test(path)));

function packagesImportedBy(path: string) {
  const source = readFileSync(join(repoRoot, path), "utf8"),
    found = new Set<string>(),
    pattern = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]!;
    if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("node:")) continue;
    const [first, second] = specifier.split("/");
    const name = specifier.startsWith("@") ? `${first}/${second}` : first!;
    if (!builtinModules.includes(name)) found.add(name);
  }
  return found;
}

// @verifies DES-CLI-LAUNCH, ARCH-CLI, REQ-CLI-06, SN-06
describe("the user's project imports only what it installs", () => {
  it("finds every package that shipped code imports in the trimmed dependency list", () => {
    expect(shipped.length).toBeGreaterThan(40);
    const missing = shipped.flatMap(path =>
      [...packagesImportedBy(path)].filter(name => !installed.has(name)).map(name => `${path} -> ${name}`)
    );
    expect(missing).toEqual([]);
  });

  it("never lets shipped code reach into the hosted service", () => {
    const reaching = shipped.filter(path => /@\/lib\/web\/|\/lib\/web\//.test(readFileSync(join(repoRoot, path), "utf8")));
    expect(reaching).toEqual([]);
  });
});
