import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

async function firstSection() {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");
  return readme.split(/^## /m)[1] ?? "";
}

// @verifies ARCH-MCP
describe("the README's Claude section", () => {
  // @verifies REQ-AGENT-3
  it("says the project folder needs mcp/server.ts and how to get one when an existing folder lacks it", async () => {
    const section = await firstSection();
    // The extension and `claude mcp add` both start <project>/mcp/server.ts; packages up to 1.1.0 do not contain it.
    expect(section).toMatch(/must contain `mcp\/server\.ts`/);
    expect(section).toMatch(/up to 1\.1\.0 do not ship it/);
    // bin/wanderpage.js reuses an existing project folder without copying new files into it.
    expect(section).toMatch(/does not update an existing folder/);
    expect(section).toMatch(/npx @buildproven\/wanderpage@latest ~\/wanderpage-claude/);
    expect(section).toMatch(/checkout of this\s+repository after `pnpm install`/);
  });
});
