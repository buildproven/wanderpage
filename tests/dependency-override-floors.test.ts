import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/workspace";

// First patched release per major line for the Dependabot alerts on main that no Dependabot update could reach
// (fast-uri and qs are production; the rest are dev-only and outside the high-severity production audit).
const FLOORS: Record<string, { major: number; floor: string }> = {
  "fast-uri": { major: 4, floor: "4.2.3" },
  qs: { major: 6, floor: "6.16.1" },
  "js-yaml": { major: 4, floor: "4.3.2" },
  vite: { major: 8, floor: "8.1.6" },
  "node-forge": { major: 1, floor: "1.4.3" },
  "postcss-selector-parser": { major: 7, floor: "7.1.6" },
  minimatch: { major: 11, floor: "11.0.1" },
};
// The vulnerable versions the stale open overrides admitted.
const STALE: Record<string, string> = { "fast-uri": "4.2.1", qs: "6.16.0", minimatch: "10.2.5" };
// Packages whose advisory spans several major lines, so no locked version on any line may sit below the floor
// (minimatch GHSA-g3hv-75wg-m249: vulnerable >= 7.0.0, < 11.0.1).
const ALL_LINE_FLOORS: Record<string, string> = { minimatch: "11.0.1" };

const parse = (version: string) => version.split(/[-+]/)[0]!.split(".").map(Number);
function compare(a: string, b: string): number {
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

/** Every resolved version of each package named in the lockfile's `packages:` and `snapshots:` keys. */
function lockedVersions(lockfile: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  for (const match of lockfile.matchAll(/^ {2}'?((?:@[^@/\s']+\/)?[^@\s']+)@(\d+\.\d+\.\d+[^\s(':]*)/gm)) {
    const [, name, version] = match;
    versions.set(name!, (versions.get(name!) ?? new Set()).add(version!));
  }
  return versions;
}

/** The `overrides:` map of pnpm-workspace.yaml (selector -> range), read without a YAML dependency. */
function workspaceOverrides(workspace: string): Map<string, string> {
  const block = /^overrides:\n((?: {2}.*\n?)*)/m.exec(workspace)?.[1] ?? "";
  const entries = new Map<string, string>();
  for (const line of block.split("\n")) {
    const entry = /^ {2}("?)(.+?)\1:\s*"?(.*?)"?\s*$/.exec(line);
    if (entry) entries.set(entry[2]!, entry[3]!);
  }
  return entries;
}

/** Whether an override range admits a version: every `>=`, `>`, `<`, `<=` or exact comparator must hold. */
function admits(range: string, version: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every(comparator => {
      const parsed = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2}(?:-[\w.]+)?)$/.exec(comparator);
      if (!parsed) throw new Error(`unsupported override comparator "${comparator}" in "${range}"`);
      const [, op = "", bound = ""] = parsed;
      const order = compare(version, bound);
      if (op === ">=") return order >= 0;
      if (op === ">") return order > 0;
      if (op === "<=") return order <= 0;
      if (op === "<") return order < 0;
      return order === 0;
    });
}

/** Override entries that target a package, either by bare name or by a `name@range` selector. */
const entriesFor = (overrides: Map<string, string>, name: string) =>
  [...overrides].filter(([selector]) => selector === name || selector.startsWith(`${name}@`));

const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");

// @verifies ARCH-RELEASE, REQ-REL-01, SN-11
describe("dependency override floors", () => {
  it("REQ-DEPS-4: every locked version on each advised major line is at or above its patched floor", () => {
    const locked = lockedVersions(lockfile);
    for (const [name, { major, floor }] of Object.entries(FLOORS)) {
      const onLine = [...(locked.get(name) ?? [])].filter(version => parse(version)[0] === major);
      expect(onLine.length, `${name}@${major}.x is not in pnpm-lock.yaml`).toBeGreaterThan(0);
      for (const version of onLine) expect(compare(version, floor), `${name}@${version} < ${floor}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("REQ-DEPS-6: every locked version of a multi-line advised package is at or above its floor", () => {
    const locked = lockedVersions(lockfile);
    for (const [name, floor] of Object.entries(ALL_LINE_FLOORS)) {
      const versions = [...(locked.get(name) ?? [])];
      expect(versions.length, `${name} is not in pnpm-lock.yaml`).toBeGreaterThan(0);
      for (const version of versions) expect(compare(version, floor), `${name}@${version} < ${floor}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("REQ-DEPS-5: no override entry for an advised package admits a version below its floor", () => {
    const overrides = workspaceOverrides(workspace);
    for (const [name, stale] of Object.entries(STALE)) {
      const entries = entriesFor(overrides, name);
      expect(entries.length, `${name} has no override in pnpm-workspace.yaml`).toBeGreaterThan(0);
      for (const [selector, range] of entries) expect(admits(range, stale), `${selector}: "${range}" admits ${stale}`).toBe(false);
    }
    for (const [name, { major, floor }] of Object.entries(FLOORS))
      for (const [selector, range] of entriesFor(overrides, name)) {
        const lastBelowFloor = `${major}.${parse(floor)[1]}.${parse(floor)[2]! - 1}`;
        expect(admits(range, lastBelowFloor), `${selector}: "${range}" admits ${lastBelowFloor}`).toBe(false);
      }
  });

  it("parses lockfile keys, workspace overrides and override ranges", () => {
    const sample = "packages:\n\n  '@scope/pkg@1.2.3':\n  fast-uri@4.2.1:\n\nsnapshots:\n\n  vite@8.1.4(@types/node@26.6.3):\n";
    expect(lockedVersions(sample)).toEqual(
      new Map([
        ["@scope/pkg", new Set(["1.2.3"])],
        ["fast-uri", new Set(["4.2.1"])],
        ["vite", new Set(["8.1.4"])],
      ])
    );
    const overrides = workspaceOverrides(
      'allowBuilds:\n  a: true\noverrides:\n  qs: ">=6.16.1"\n  "vite@>=8 <8.1.6": ">=8.1.6 <9"\nnext: 1\n'
    );
    expect(overrides).toEqual(
      new Map([
        ["qs", ">=6.16.1"],
        ["vite@>=8 <8.1.6", ">=8.1.6 <9"],
      ])
    );
    expect(admits(">=3.1.6", "4.2.1")).toBe(true);
    expect(admits(">=6.16.0", "6.16.0")).toBe(true);
    expect(admits(">=4.2.3", "4.2.1")).toBe(false);
    expect(admits(">=8.1.6 <9", "9.0.0")).toBe(false);
    expect(admits("5.1.16", "5.1.16")).toBe(true);
    expect(() => admits("^4.2.0", "4.2.1")).toThrow(/unsupported override comparator/);
  });
});
