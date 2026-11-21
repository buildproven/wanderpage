import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions } from "../../bin/local-edition.js";
import { repoRoot } from "../helpers/workspace";

type FirstEntry = { heading: string; version: string; body: string };

// Reads the first `## ` entry of a changelog: its heading line, its version, and the text up to the next entry.
function firstEntry(changelog: string): FirstEntry {
  const match = /^## (.+)$/m.exec(changelog);
  if (!match) throw new Error("CHANGELOG.md has no `## ` entry");
  const title = match[1] ?? "";
  const version = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(title)?.[1];
  if (!version) throw new Error(`CHANGELOG.md's first entry "## ${title}" does not start with a version`);
  const rest = changelog.slice(match.index + match[0].length);
  const next = /^## /m.exec(rest);
  return { heading: match[0], version, body: next ? rest.slice(0, next.index) : rest };
}

// Returns why the changelog is behind the package, or undefined when its first entry is not older than the package version.
function changelogBehind(changelog: string, packageVersion: string): string | undefined {
  const { version } = firstEntry(changelog);
  if (compareVersions(version, packageVersion) >= 0) return undefined;
  return `CHANGELOG.md's first entry is ${version}, older than package.json's version ${packageVersion}: add a ## ${packageVersion} entry`;
}

const read = (path: string) => readFile(join(repoRoot, path), "utf8");

// @verifies DES-REL-RELEASE, ARCH-RELEASE, REQ-REL-02
describe("CHANGELOG (BUI-2074)", () => {
  it("REQ-REL-02 opens with the 1.2.0 entry for the Claude plugin, the desktop extension and the skill ZIP", async () => {
    const entry = firstEntry(await read("CHANGELOG.md"));
    expect(entry.heading).toBe("## 1.2.0 — 2026-11-21");
    expect(entry.body).toMatch(/Claude plugin/);
    expect(entry.body).toMatch(/Claude Desktop extension/);
    expect(entry.body).toMatch(/`wanderpage\.mcpb`/);
    expect(entry.body).toMatch(/skill ZIP/);
    expect(entry.body).toMatch(/1\.1\.0 or earlier/);
    expect(entry.body).toMatch(/`npx @buildproven\/wanderpage@latest/);
  });

  it("REQ-REL-02 has a first entry that is not older than package.json's version", async () => {
    const pkg = JSON.parse(await read("package.json")) as { version: string };
    expect(changelogBehind(await read("CHANGELOG.md"), pkg.version)).toBeUndefined();
  });

  it("REQ-REL-02 names both versions when the first entry is older than the package version", () => {
    const changelog = "# Changelog\n\n## 1.1.0 — 2026-10-10\n\n- Old.\n\n## 1.0.0 — 2026-10-04\n";
    const problem = changelogBehind(changelog, "1.2.0");
    expect(problem).toContain("1.1.0");
    expect(problem).toContain("1.2.0");
    expect(changelogBehind(changelog, "1.1.0")).toBeUndefined();
    expect(changelogBehind(changelog, "1.0.9")).toBeUndefined();
    expect(changelogBehind("# Changelog\n\n## 1.10.0 — 2026-12-01\n", "1.9.0"), "versions compare numerically").toBeUndefined();
    expect(changelogBehind("# Changelog\n\n## 1.2.0-beta.1 — 2026-11-20\n", "1.2.0"), "a pre-release is older").toContain("1.2.0-beta.1");
  });

  it("REQ-REL-02 refuses a changelog with no entry or an entry with no version", () => {
    expect(() => firstEntry("# Changelog\n")).toThrow("no `## ` entry");
    expect(() => firstEntry("# Changelog\n\n## Unreleased\n")).toThrow('"## Unreleased" does not start with a version');
  });
});
