import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

async function claudeSection() {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");
  return (readme.split(/^## /m)[1] ?? "").replace(/\s+/g, " ");
}

function parts(version: string) {
  return version.split(".").map(Number);
}

function notAfter(a: string, b: string) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) < (y[i] ?? 0);
  return true;
}

// @verifies ARCH-MCP
describe("the README's advice for a project folder without mcp/server.ts (BUI-2170)", () => {
  // @verifies REQ-AGENT-3
  it("names a released version that ships mcp/server.ts, not an unreleased 'version after' one", async () => {
    const section = await claudeSection();
    expect(section).not.toMatch(/a version after/);
    const named = /[Vv]ersion (\d+\.\d+\.\d+) or later/.exec(section)?.[1];
    expect(named, "README names the first version that ships mcp/server.ts").toBeDefined();
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string; files: string[] };
    const changelog = await readFile(join(repoRoot, "CHANGELOG.md"), "utf8");
    // The named version is released (it has a changelog entry) and is not newer than this package.
    expect(changelog).toMatch(new RegExp(`^## ${(named ?? "").replace(/\./g, "\\.")} `, "m"));
    expect(notAfter(named ?? "", pkg.version)).toBe(true);
    expect(pkg.files).toContain("mcp");
  });

  // @verifies REQ-AGENT-3
  it("says re-running the latest launcher updates an existing folder", async () => {
    const section = await claudeSection();
    // bin/wanderpage.js (since BUI-2036, in 1.2.0) refreshes an older project folder in place.
    expect(section).toMatch(/run `npx @buildproven\/wanderpage@latest` again from the same folder/);
    expect(section).toMatch(/updates the existing folder/);
  });
});
