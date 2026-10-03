import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  bin: Record<string, string>;
  license: string;
};

// @verifies ARCH-RELEASE, REQ-REL-01, SN-11
describe("package supply-chain policy", () => {
  it("declares no unpinned latest range or network-fetched script", () => {
    const ranges = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.entries(ranges).filter(([, range]) => /^(latest|\*|next)$/.test(range))).toEqual([]);
    expect(Object.entries(pkg.scripts).filter(([, command]) => /@latest/.test(command))).toEqual([]);
  });

  it("ships only an allowlist of files and never an env file, report, cache, or test photo", () => {
    expect(pkg.files).toContain("bin");
    expect(pkg.files.filter(entry => /^\.env(?!\.example)|\.trip-|tests|output|demo-photos/.test(entry))).toEqual([]);
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: repoRoot, encoding: "utf8" })
    ) as Array<{
      files: Array<{ path: string }>;
    }>;
    const paths = packed[0]!.files.map(file => file.path);
    expect(paths).toContain("bin/wanderpage.js");
    expect(paths).toContain("LICENSE");
    expect(paths.filter(path => /(^|\/)\.env(\.local)?$|\.trip-(cache|output)|^tests\/|^\.git\//.test(path))).toEqual([]);
  }, 60_000);

  it("lists every runtime tool of the shipped launcher as a dependency", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(expect.arrayContaining(["tsx", "commander", "sharp", "exifr", "zod"]));
    expect(Object.keys(pkg.devDependencies)).not.toContain("tsx");
  });

  it("is licensed and exposes the wanderpage command", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.bin.wanderpage).toBe("./bin/wanderpage.js");
  });

  it("runs a high-severity production audit in CI and in the project gate", async () => {
    const quality = await readFile(join(repoRoot, ".github/workflows/quality.yml"), "utf8");
    expect(quality).toContain("pnpm audit --audit-level high --prod");
    expect(pkg.scripts["security:audit"]).toBe("pnpm audit --audit-level high --prod");
    expect(JSON.parse(await readFile(join(repoRoot, "keel.json"), "utf8")).acceptance.audit).toBe("pnpm audit --audit-level high --prod");
  });
});
