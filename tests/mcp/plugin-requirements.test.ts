import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const productionMcpUrl = "https://wanderpage.buildproven.ai/api/mcp";

const readText = (path: string) => readFile(join(repoRoot, path), "utf8");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readText(path)) as T;
const plain = (text: string) => text.replace(/\s+/g, " ");

function requirementBody(requirements: string, id: string): string {
  const start = requirements.search(new RegExp(`^### ${id} `, "m"));
  if (start < 0) throw new Error(`docs/REQUIREMENTS.md has no ${id} heading`);
  const rest = requirements.slice(requirements.indexOf("\n", start) + 1);
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// @verifies ARCH-MCP
describe("REQ-PLUGIN requirements (BUI-2173)", () => {
  // @verifies REQ-PLUGIN-1, REQ-PLUGIN-2, REQ-PLUGIN-3
  it("defines every REQ-PLUGIN id that the plugin tests name, and links each to ARCH-MCP", async () => {
    const requirements = await readText("docs/REQUIREMENTS.md");
    const architecture = await readText("docs/ARCHITECTURE.md");
    const pluginTests = await readText("tests/mcp/plugin.test.ts");
    const named = [...new Set(pluginTests.match(/\bREQ-PLUGIN-\d+\b/g) ?? [])].sort();
    expect(named).toEqual(["REQ-PLUGIN-1", "REQ-PLUGIN-2", "REQ-PLUGIN-3"]);
    const satisfies = /^### ARCH-MCP [\s\S]*?^- \*\*Satisfies:\*\*(.*)$/m.exec(architecture)?.[1] ?? "";
    for (const id of named) {
      const body = requirementBody(requirements, id);
      expect(body, id).toMatch(/^- \*\*Needs:\*\* SN-\d+/m);
      expect(
        satisfies.split(",").map(entry => entry.trim()),
        id
      ).toContain(id);
    }
    // The old prose paragraph described a local stdio server; the plugin now points at the hosted server.
    expect(plain(requirementBody(requirements, "REQ-PLUGIN-2"))).not.toMatch(/local stdio/i);
  });

  // @verifies REQ-PLUGIN-1
  it("REQ-PLUGIN-1: plugin.json names wanderpage at the package.json version and npm test runs the validate test", async () => {
    const plugin = await readJson<{ name?: unknown; version?: unknown }>(".claude-plugin/plugin.json");
    const pkg = await readJson<{ version: string; scripts: { test: string } }>("package.json");
    expect(plugin.name).toBe("wanderpage");
    expect(plugin.version).toBe(pkg.version);
    expect(pkg.scripts.test).toMatch(/^vitest run\b/);
    const pluginTests = await readText("tests/mcp/plugin.test.ts");
    expect(pluginTests).toMatch(/spawnSync\("claude", \["plugin", "validate", "\."\]/);
  });

  // @verifies REQ-PLUGIN-2
  it("REQ-PLUGIN-2: the plugin points only at the hosted MCP server and links its privacy page", async () => {
    const config = await readJson<{ mcpServers: Record<string, unknown> }>(".mcp.json");
    expect(config.mcpServers).toEqual({ wanderpage: { type: "http", url: productionMcpUrl } });
    const plugin = await readJson<Record<string, unknown> & { network?: { hosts?: unknown }; description: string }>(
      ".claude-plugin/plugin.json"
    );
    const host = new URL(productionMcpUrl).hostname;
    expect(plugin).not.toHaveProperty("userConfig");
    expect(plugin.network?.hosts).toEqual([host]);
    expect(plugin.privacyPolicyUrl).toBe(`https://${host}/privacy`);
    expect(plain(plugin.description)).toMatch(/one-time link, in Claude on the web, desktop and phone/i);
  });

  // @verifies REQ-PLUGIN-3
  it("REQ-PLUGIN-3: the README gives the claude.ai plugin first and the local servers after, as the offline option", async () => {
    const readme = await readText("README.md");
    const section = readme.split(/^## /m).find(text => text.startsWith("Use Wanderpage in Claude"));
    if (!section) throw new Error("README.md has no Use Wanderpage in Claude section");
    const text = plain(section);
    const offline = text.indexOf("**Offline, on your Mac.**");
    expect(text.indexOf("Customize > Plugins, then select **Connect**")).toBeGreaterThan(-1);
    expect(offline).toBeGreaterThan(text.indexOf("Customize > Plugins"));
    const hosted = text.slice(0, offline);
    expect(hosted).toContain("/plugin install wanderpage --marketplace buildproven/claude-plugins");
    expect(hosted).toMatch(/web, in Claude Desktop, in the mobile apps and in Claude Code/);
    const local = text.slice(offline);
    expect(local).toContain("claude mcp add");
    expect(local).toMatch(/\.mcpb/);
    expect(local).toMatch(/chat on the web and in the mobile apps cannot reach a local server/i);
  });
});
