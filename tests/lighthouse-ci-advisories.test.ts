import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// BUI-1951: Lighthouse CI 0.14 pulled extract-zip (no patched version) and 11 other advisories into the lockfile.
const root = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

// Floors from the Dependabot advisories; `major` limits a floor to one major line (js-yaml 4.x is unaffected).
const FLOORS: { name: string; floor: string; major?: number }[] = [
  { name: "js-yaml", floor: "3.15.2", major: 3 },
  { name: "tmp", floor: "0.2.6" },
  { name: "uuid", floor: "11.1.1" },
  { name: "basic-ftp", floor: "6.2.4" },
  { name: "ip-address", floor: "10.7.1" },
  { name: "cookie", floor: "0.7.0" },
];

const parse = (version: string) => version.split(/[-+]/)[0]!.split(".").map(Number);

function compare(a: string, b: string): number {
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

/** Keys of the lockfile's top-level `packages:` map, as `name@version`. */
function lockPackageKeys(lockfile: string): string[] {
  const keys: string[] = [];
  let inPackages = false;
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
    else if (inPackages) {
      const match = /^ {2}'?([^\s':][^\s']*)'?:/.exec(line);
      if (match) keys.push(match[1]!);
    }
  }
  return keys;
}

function versionsOf(keys: string[], name: string): string[] {
  return keys.filter(key => key.startsWith(`${name}@`)).map(key => key.slice(name.length + 1));
}

/** Versions that break a floor; the floor applies to every version, or only to `major` when set. */
function belowFloor(keys: string[], { name, floor, major }: (typeof FLOORS)[number]): string[] {
  return versionsOf(keys, name).filter(version => (major === undefined || parse(version)[0] === major) && compare(version, floor) < 0);
}

/** True when a caret range (`^x.y.z`) admits `version`. */
function caretAdmits(range: string, version: string): boolean {
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  if (!match) throw new Error(`unsupported range ${range}`);
  const [base, candidate] = [parse(match[1]!), parse(version)];
  const lock = base[0]! > 0 ? 1 : base[1]! > 0 ? 2 : 3;
  for (let i = 0; i < lock; i += 1) if (base[i] !== candidate[i]) return false;
  return compare(version, match[1]!) >= 0;
}

const keys = lockPackageKeys(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));

// @verifies ARCH-RELEASE, REQ-REL-01, SN-11
describe("Lighthouse CI dependency advisories (BUI-1951)", () => {
  it("REQ-DEPS-1: the lockfile has no extract-zip package", () => {
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter(key => key.startsWith("extract-zip@"))).toEqual([]);
  });

  it.each(FLOORS)("REQ-DEPS-2: every locked $name meets $floor", entry => {
    expect(belowFloor(keys, entry)).toEqual([]);
  });

  it("REQ-DEPS-2: floor checks catch vulnerable versions and spare other major lines", () => {
    const sample = ["js-yaml@3.15.0", "js-yaml@4.1.0", "tmp@0.0.33", "tmp@0.2.6"];
    expect(belowFloor(sample, FLOORS[0]!)).toEqual(["3.15.0"]);
    expect(belowFloor(sample, FLOORS[1]!)).toEqual(["0.0.33"]);
    expect(lockPackageKeys("packages:\n\n  '@lhci/cli@0.16.1':\n    resolution: {}\n  tmp@0.2.6:\nsnapshots:\n  tmp@0.0.1: {}\n")).toEqual([
      "@lhci/cli@0.16.1",
      "tmp@0.2.6",
    ]);
  });

  it("REQ-DEPS-3: the root @lhci/cli range admits 0.16.1 and the installed lhci is 0.16.x", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(caretAdmits(pkg.devDependencies["@lhci/cli"]!, "0.16.1")).toBe(true);
    expect(caretAdmits("^0.14.0", "0.16.1")).toBe(false);
    expect(pkg.scripts["lighthouse:ci"]).toBe("lhci autorun");

    const manifest = require.resolve("@lhci/cli/package.json");
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: Record<string, string> };
    const printed = execFileSync(process.execPath, [join(manifest, "..", bin.lhci!), "--version"], { encoding: "utf8" });
    expect(printed.trim()).toMatch(/^0\.16\.\d+$/);
  });

  it("REQ-DEPS-3: .lighthouserc.cjs still loads with a ci key", () => {
    const config = require(join(root, ".lighthouserc.cjs")) as Record<string, unknown>;
    expect(config).toHaveProperty("ci");
  });
});
