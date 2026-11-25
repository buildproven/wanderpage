import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const iconPath = join(repoRoot, ".claude-plugin/icon.png");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function claudeCliMissing(): string | null {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error) return `claude CLI not found on PATH (${probe.error.message})`;
  if (probe.status !== 0) return `claude --version exited ${probe.status}`;
  return null;
}

describe("REQ-PLUGIN-1 plugin icon (BUI-2177)", () => {
  // @verifies REQ-PLUGIN-1
  it("ships .claude-plugin/icon.png as a square PNG of 512 to 2048 px under 2 MB", async () => {
    const icon = await readFile(iconPath);
    expect(icon.subarray(0, 8).equals(pngSignature)).toBe(true);
    expect(icon.subarray(12, 16).toString("ascii")).toBe("IHDR");
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(icon.byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  // @verifies REQ-PLUGIN-1
  it("validates at the repo root without an ICON_MISSING warning", async ctx => {
    const missing = claudeCliMissing();
    if (missing) {
      const reason = `REQ-PLUGIN-1 icon validate skipped: ${missing}`;
      console.warn(reason);
      ctx.skip(reason);
    }
    const validation = spawnSync("claude", ["plugin", "validate", "."], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const output = `${validation.stdout}${validation.stderr}`;
    expect(validation.status, output).toBe(0);
    expect(output).toMatch(/Validation passed/i);
    expect(output).not.toMatch(/ICON_MISSING/);
  });
});
