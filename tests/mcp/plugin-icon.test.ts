import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function claudeCliMissing(): string | null {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error) return `claude CLI not found on PATH (${probe.error.message})`;
  if (probe.status !== 0) return `claude --version exited ${probe.status}`;
  return null;
}

// @verifies ARCH-MCP
describe("the Claude plugin icon", () => {
  // @verifies REQ-AGENT-3
  it("is a square PNG between 512 and 2048 pixels at .claude-plugin/icon.png", async () => {
    const bytes = await readFile(join(repoRoot, ".claude-plugin/icon.png"));
    expect(bytes.subarray(0, 8).equals(pngSignature)).toBe(true);
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
  });

  // @verifies REQ-AGENT-3
  it("makes claude plugin validate stop warning ICON_MISSING", () => {
    const missing = claudeCliMissing();
    if (missing) {
      console.warn(`skipping plugin validate: ${missing}`);
      return;
    }
    const result = spawnSync("claude", ["plugin", "validate", "."], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("ICON_MISSING");
  });
});
