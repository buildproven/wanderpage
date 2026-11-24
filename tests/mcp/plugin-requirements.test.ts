import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const productionHost = "wanderpage.buildproven.ai";
const productionMcpUrl = `https://${productionHost}/api/mcp`;

async function readText(path: string): Promise<string> {
  return readFile(join(repoRoot, path), "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}

const plain = (text: string) => text.replace(/\s+/g, " ");

function claudeCliMissing(): string | null {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error) return `claude CLI not found on PATH (${probe.error.message})`;
  if (probe.status !== 0) return `claude --version exited ${probe.status}`;
  return null;
}

describe("REQ-PLUGIN requirements", () => {
  // @verifies REQ-PLUGIN-1
  it("REQ-PLUGIN-1: the repo root is the wanderpage plugin at the package.json version and validates without a version warning", async ctx => {
    const plugin = await readJson<{ name?: unknown; version?: unknown }>(".claude-plugin/plugin.json");
    const pkg = await readJson<{ version: string; scripts: { test: string } }>("package.json");
    expect(plugin.name).toBe("wanderpage");
    expect(plugin.version).toBe(pkg.version);
    expect(pkg.scripts.test).toMatch(/^vitest run\b/);

    const missing = claudeCliMissing();
    if (missing) {
      const reason = `REQ-PLUGIN-1 validate skipped: ${missing}`;
      console.warn(reason);
      ctx.skip(reason);
    }
    const validation = spawnSync("claude", ["plugin", "validate", "."], { cwd: repoRoot, encoding: "utf8" });
    const output = `${validation.stdout}${validation.stderr}`;
    expect(validation.status, output).toBe(0);
    expect(output).toMatch(/Validation passed/i);
    expect(output).not.toMatch(/MANIFEST_NOT_FOUND|No version specified/i);
    expect(output).toContain(`mcpServers: wanderpage http ${productionMcpUrl}`);
  }, 60_000);

  // @verifies REQ-PLUGIN-2
  it("REQ-PLUGIN-2: .mcp.json holds only the hosted http server and plugin.json declares only its host", async () => {
    const config = await readJson<{ mcpServers: Record<string, unknown> }>(".mcp.json");
    expect(config).toEqual({ mcpServers: { wanderpage: { type: "http", url: productionMcpUrl } } });

    const plugin = await readJson<Record<string, unknown> & { network?: { hosts?: unknown }; description?: unknown }>(
      ".claude-plugin/plugin.json"
    );
    expect(plugin).not.toHaveProperty("userConfig");
    expect(plugin).not.toHaveProperty("mcpServers");
    expect(plugin.network?.hosts).toEqual([productionHost]);
    expect(plugin.privacyPolicyUrl).toBe(`https://${productionHost}/privacy`);
    expect(plain(String(plugin.description))).toMatch(/upload(?:ed)? through a one-time link/i);
  });

  // @verifies REQ-PLUGIN-3
  it("REQ-PLUGIN-3: the README gives the claude.ai plugin and marketplace install before the offline local option", async () => {
    const readme = await readText("README.md");
    const section = readme.split(/^## /m).find(text => text.startsWith("Use Wanderpage in Claude"));
    expect(section, "README.md Use Wanderpage in Claude section").toBeDefined();
    const text = plain(section ?? "");
    const plugin = text.indexOf("Customize > Plugins, then select **Connect**");
    const marketplace = text.indexOf("/plugin install wanderpage --marketplace buildproven/claude-plugins");
    const offline = text.indexOf("**Offline, on your Mac.**");
    expect(plugin, "claude.ai plugin install").toBeGreaterThan(-1);
    expect(marketplace, "marketplace install").toBeGreaterThan(plugin);
    expect(offline, "offline option").toBeGreaterThan(marketplace);
    expect(text.slice(0, offline)).toMatch(/web, in Claude Desktop, in the mobile apps and in Claude Code/);
    expect(text.slice(offline)).toMatch(/chat on the web and in the mobile apps cannot reach a local server/i);
    expect(text.slice(offline)).toMatch(/\.mcpb/);
    expect(text.slice(offline)).toMatch(/claude mcp add/);
  });
});
