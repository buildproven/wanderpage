import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

async function claudeSection() {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");
  return (readme.split(/^## /m)[1] ?? "").replace(/\s+/g, " ");
}

// @verifies ARCH-MCP
describe("the README's update advice for a project folder without mcp/server.ts (BUI-2170)", () => {
  // @verifies REQ-AGENT-3
  it("says to re-run the launcher where it first ran, with the same path, not from inside the project folder", async () => {
    const section = await claudeSection();
    // bin/wanderpage.js:17 resolves the project to ./wanderpage or the path argument, so the run location and path must match the first run.
    expect(section).toMatch(/where you first ran it/);
    expect(section).toMatch(/not from inside the project folder/);
    expect(section).toMatch(/give the same folder path again/);
  });
});
