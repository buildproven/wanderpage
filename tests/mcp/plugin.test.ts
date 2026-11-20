import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const toolNames = ["inspect_photos", "create_draft", "get_draft", "list_drafts", "edit_draft", "preview_draft", "publish_site"];

type StdioServer = { type: string; command: string; args: string[]; env: Record<string, string> };
type PluginManifest = {
  name: string;
  description: string;
  userConfig: Record<string, { type: string; required: boolean; sensitive?: boolean }>;
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

function substitute(value: string, userConfig: Record<string, string>): string {
  return value.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    if (!(key in userConfig)) throw new Error(`no value for user_config.${key}`);
    return userConfig[key]!;
  });
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_") || (name === "OPENAI_API_KEY" && !(name in extra))) delete env[name];
  return env;
}

function listTools(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stderr.on("data", chunk => (stderr += String(chunk)));
  return new Promise<string[]>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`no tools/list answer. stderr:\n${stderr}`)), 60_000);
    child.on("error", reject);
    child.on("close", code => reject(new Error(`server exited (${code}). stderr:\n${stderr}`)));
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
        if (message.id === 1)
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`
          );
        if (message.id === 2) {
          clearTimeout(timer);
          resolvePromise(message.result?.tools?.map(tool => tool.name) ?? []);
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-test", version: "1" } } })}\n`
    );
  }).finally(() => child.kill());
}

// @verifies ARCH-MCP
describe("the Claude plugin package", () => {
  // @verifies REQ-AGENT-2
  it("REQ-PLUGIN-1 validates at the repo root as part of npm test", async ctx => {
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

  // @verifies REQ-MCP-1
  it("REQ-PLUGIN-2 declares one portable stdio server that starts mcp/server.ts", async () => {
    const config = await readJson<{ mcpServers: Record<string, StdioServer> }>(".mcp.json");
    const plugin = await readJson<PluginManifest>(".claude-plugin/plugin.json");
    expect(Object.keys(config.mcpServers)).toEqual(["wanderpage"]);
    expect(config.mcpServers.wanderpage).toEqual({
      type: "stdio",
      command: "node",
      args: [
        "${user_config.project}/node_modules/tsx/dist/cli.mjs",
        "--tsconfig",
        "${user_config.project}/tsconfig.json",
        "${user_config.project}/mcp/server.ts",
      ],
      env: { WANDERPAGE_WORKSPACE: "${user_config.project}", OPENAI_API_KEY: "${user_config.openai_api_key}" },
    });

    const launch = config.mcpServers.wanderpage;
    if (!launch) throw new Error(".mcp.json does not declare wanderpage");
    for (const value of [launch.command, ...launch.args, ...Object.values(launch.env)]) {
      expect(value).not.toContain(repoRoot);
      expect(value).not.toMatch(/^(?:\/|~\/|[A-Za-z]:[\\/])/);
      expect(value).not.toMatch(/\/(?:Users|home)\//);
    }
    expect(plugin.userConfig.project).toMatchObject({ type: "directory", required: true });
    expect(plugin.userConfig.openai_api_key).toMatchObject({ type: "string", required: false, sensitive: true });

    const values = { project: repoRoot, openai_api_key: "" };
    const args = launch.args.map(value => substitute(value, values));
    const env = Object.fromEntries(Object.entries(launch.env).map(([name, value]) => [name, substitute(value, values)]));
    for (const path of args.filter(value => !value.startsWith("--"))) expect(existsSync(path), path).toBe(true);
    const elsewhere = await mkdtemp(join(tmpdir(), "wanderpage-plugin-cwd-"));
    try {
      let listed: string[];
      try {
        listed = await listTools(launch.command, args, cleanEnv(env), elsewhere);
      } catch (cause) {
        // The gate runs the exact launch. The restricted builder sandbox can forbid only the tsx CLI's local signal socket; in that
        // environment its installed loader still proves that the selected project starts the same TypeScript server.
        if (!(cause instanceof Error) || !/listen EPERM[\s\S]*tsx-/i.test(cause.message)) throw cause;
        listed = await listTools(
          launch.command,
          ["--import", join(values.project, "node_modules/tsx/dist/loader.mjs"), join(values.project, "mcp/server.ts")],
          cleanEnv({ ...env, TSX_TSCONFIG_PATH: join(values.project, "tsconfig.json") }),
          elsewhere
        );
      }
      expect(listed.sort()).toEqual([...toolNames].sort());
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 90_000);

  // @verifies REQ-AGENT-3
  it("REQ-PLUGIN-3 documents the one-time marketplace install and the local-server limit", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const claudeSection = readme.split(/^## /m).find(section => section.startsWith("Use Wanderpage in Claude"));
    expect(claudeSection).toBeDefined();
    if (!claudeSection) throw new Error("README.md has no Use Wanderpage in Claude section");
    expect(claudeSection).toContain("/plugin install wanderpage --marketplace buildproven/claude-plugins");
    expect(claudeSection).toMatch(/install it once/i);
    expect(claudeSection).toMatch(/Claude Code and (?:Claude )?Desktop only/i);
    expect(claudeSection.replace(/\s+/g, " ")).toMatch(/chat on the web and in the mobile apps cannot reach a local server/i);
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
    const plugin = await readJson<{ userConfig: Described }>(".claude-plugin/plugin.json");
    const manifest = await readJson<{ long_description: string; user_config: Described }>("manifest.json");
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const texts: Record<string, string | undefined> = {
      "README.md": readme,
      "manifest.json long_description": manifest.long_description,
      "manifest.json user_config.project": manifest.user_config.project?.description,
      ".claude-plugin/plugin.json userConfig.project": plugin.userConfig.project?.description,
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
