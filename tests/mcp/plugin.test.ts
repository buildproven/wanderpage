import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertPreviewUrl } from "@/lib/web/preview-policy";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const productionMcpUrl = "https://wanderpage.buildproven.ai/api/mcp";

type McpServerEntry = Record<string, unknown> & { type?: unknown; url?: unknown };
type PluginManifest = {
  name: string;
  description: string;
  userConfig?: unknown;
  network?: { hosts?: unknown };
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(repoRoot, path), "utf8")) as T;
}

function claudeCliMissing(): string | null {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error) return `claude CLI not found on PATH (${probe.error.message})`;
  if (probe.status !== 0) return `claude --version exited ${probe.status}`;
  return null;
}

function claudeSection(readme: string): string {
  const section = readme.split(/^## /m).find(text => text.startsWith("Use Wanderpage in Claude"));
  if (!section) throw new Error("README.md has no Use Wanderpage in Claude section");
  return section;
}

// @verifies ARCH-MCP
describe("the Claude plugin package", () => {
  // @verifies REQ-AGENT-2
  it("REQ-PLUGIN-1 (BUI-2101 R3) validates at the repo root as part of npm test", async ctx => {
    const plugin = await readJson<PluginManifest>(".claude-plugin/plugin.json");
    const pkg = await readJson<{ scripts: { test: string } }>("package.json");
    expect(plugin.name).toBe("wanderpage");
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(pkg.scripts.test).toMatch(/^vitest run\b/);

    const missing = claudeCliMissing();
    if (missing) {
      const reason = `REQ-PLUGIN-1 skipped: ${missing}`;
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
    expect(output).not.toMatch(/MANIFEST_NOT_FOUND/);
  }, 60_000);

  // @verifies REQ-AGENT-2
  it("BUI-2101 R1 (REQ-PLUGIN-2): .mcp.json names one http server at the production /api/mcp", async () => {
    const config = await readJson<{ mcpServers: Record<string, McpServerEntry> }>(".mcp.json");
    expect(Object.keys(config.mcpServers)).toEqual(["wanderpage"]);
    const server = config.mcpServers.wanderpage;
    if (!server) throw new Error(".mcp.json does not declare wanderpage");
    // OAuth on the hosted server signs the user in: no command, local path, header or environment value ships in the plugin.
    expect(server).toEqual({ type: "http", url: productionMcpUrl });
    const url = new URL(String(server.url));
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/api/mcp");
    expect(url.search + url.hash + url.username + url.password).toBe("");
    // lib/web/preview-policy.ts keeps the list of production hosts; the plugin must point at one of them, never at a preview.
    expect(() => assertPreviewUrl(url.href, [url.hostname])).toThrow(/Production Wanderpage domains/);
  });

  // @verifies REQ-AGENT-2
  it("BUI-2101 R2 (REQ-PLUGIN-2): plugin.json has no userConfig, declares the hosted host, and describes the one-time link", async () => {
    const plugin = await readJson<PluginManifest>(".claude-plugin/plugin.json");
    expect(plugin).not.toHaveProperty("userConfig");
    expect(plugin.network?.hosts).toEqual([new URL(productionMcpUrl).hostname]);
    const description = plugin.description.replace(/\s+/g, " ");
    expect(description).toMatch(/Wanderpage makes private trip pages from photos/i);
    expect(description).toMatch(/upload(?:ed)? through a one-time link/i);
    expect(description).toMatch(/in Claude on the web, desktop and phone/i);
    expect(description).not.toMatch(/on this Mac/i);
  });

  // @verifies REQ-AGENT-1
  it("BUI-2101 R5 (REQ-AGENT-1): the skill names upload_photos for getting photos in from chat", async () => {
    const skill = await readFile(join(repoRoot, "skills/wanderpage/SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    const description = /^description:\s*(.*)$/m.exec(frontmatter)?.[1] ?? "";
    expect(description).toContain("upload_photos");
    expect(description.length).toBeLessThanOrEqual(1024);
    const intro = skill.slice(skill.indexOf("# Wanderpage"), skill.indexOf("## Workflow"));
    expect(intro.replace(/\s+/g, " ")).toMatch(/get the photos in from chat with `upload_photos`/);
  });

  // @verifies REQ-AGENT-3
  it("BUI-2101 R4 (REQ-PLUGIN-3): the README leads with the claude.ai plugin and keeps the local servers as the offline option", async () => {
    const section = claudeSection(await readFile(join(repoRoot, "README.md"), "utf8"));
    const plain = section.replace(/\s+/g, " ");
    const plugin = plain.indexOf("Customize > Plugins");
    const offline = plain.search(/\*\*Offline, on your Mac\.\*\*/);
    expect(plugin, "claude.ai plugin install").toBeGreaterThan(-1);
    expect(offline, "offline heading").toBeGreaterThan(plugin);
    const hosted = plain.slice(0, offline);
    const local = plain.slice(offline);
    expect(hosted).toMatch(/claude\.ai plugin/);
    expect(hosted).toMatch(/Customize > Plugins, then select \*\*Connect\*\*/);
    expect(hosted).toContain(productionMcpUrl);
    expect(hosted).toMatch(/install it once/i);
    expect(hosted).toMatch(/web, in Claude Desktop, in the mobile apps and in Claude Code/);
    expect(hosted).toContain("upload_photos");
    expect(hosted).toContain("/plugin install wanderpage --marketplace buildproven/claude-plugins");
    // The Desktop extension and the Claude Code local server come after, as the offline option.
    expect(local).toMatch(/\*\*Claude Desktop extension\.\*\*/);
    expect(local).toMatch(/\.mcpb/);
    expect(local).toMatch(/claude mcp add/);
    expect(local).toMatch(/local tools work in Claude Code and Claude Desktop only/i);
    expect(local).toMatch(/chat on the web and in the mobile apps cannot reach a local server/i);
    expect(hosted).not.toMatch(/\.mcpb|claude mcp add/);
  });

  // @verifies REQ-AGENT-2
  it("REQ-PLUGIN-1 carries the package.json version, so validate reports no version warning", async ctx => {
    const plugin = await readJson<{ version?: unknown }>(".claude-plugin/plugin.json");
    const manifest = await readJson<{ version?: unknown }>("manifest.json");
    const pkg = await readJson<{ version: string }>("package.json");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(plugin.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);

    const missing = claudeCliMissing();
    if (missing) {
      const reason = `REQ-PLUGIN-1 version warning check skipped: ${missing}`;
      console.warn(reason);
      ctx.skip(reason);
    }
    const validation = spawnSync("claude", ["plugin", "validate", "."], { cwd: repoRoot, encoding: "utf8" });
    const output = `${validation.stdout}${validation.stderr}`;
    expect(validation.status, output).toBe(0);
    expect(output).not.toMatch(/No version specified/i);
  }, 60_000);

  // @verifies REQ-AGENT-3
  it("REQ-AGENT-3 names the default project folder as wanderpage in the folder where npx ran", async () => {
    type Described = Record<string, { description?: string }>;
    const manifest = await readJson<{ long_description: string; user_config: Described }>("manifest.json");
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const texts: Record<string, string | undefined> = {
      "README.md": readme,
      "manifest.json long_description": manifest.long_description,
      "manifest.json user_config.project": manifest.user_config.project?.description,
    };
    for (const [where, text] of Object.entries(texts)) {
      const plain = (text ?? "").replace(/`/g, "").replace(/\s+/g, " ");
      expect(plain, where).not.toMatch(/~\/wanderpage by default/i);
      expect(plain, where).toMatch(/wanderpage in the folder where you ran npx @buildproven\/wanderpage/i);
    }
    // bin/wanderpage.js resolves "./wanderpage" against the working directory, so a $HOME/wanderpage example holds only from home.
    const plainReadme = readme.replace(/`/g, "").replace(/\s+/g, " ");
    if (plainReadme.includes("$HOME/wanderpage"))
      expect(plainReadme).toMatch(/assumes you ran npx @buildproven\/wanderpage in your home folder/i);
  });
});
