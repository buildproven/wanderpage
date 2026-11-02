import { getMcpConfigForManifest } from "@anthropic-ai/mcpb/node";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

const run = promisify(execFile);
const mcpbCli = join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/mcpb/node")), "cli", "cli.js");
type Manifest = Parameters<typeof getMcpConfigForManifest>[0]["manifest"];
const toolNames = ["inspect_photos", "create_draft", "get_draft", "list_drafts", "edit_draft", "preview_draft", "publish_site"];

/** The environment of a child process, without the git variables a hook sets or a real OpenAI key. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_") || (name === "OPENAI_API_KEY" && !(name in extra))) delete env[name];
  return env;
}

function frontmatter(text: string) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md has no YAML frontmatter");
  const fields = Object.fromEntries(
    match[1]!
      .split("\n")
      .map(line => /^([a-z_-]+):\s*(.*)$/.exec(line))
      .filter((found): found is RegExpExecArray => Boolean(found))
      .map(found => [found[1]!, found[2]!.trim()])
  );
  return { fields, body: match[2]! };
}

// @verifies ARCH-MCP
describe("the Wanderpage skill", () => {
  // @verifies REQ-AGENT-1
  it("names its folder, keeps the description short, and gives the workflow and the privacy rules", async () => {
    const { fields, body } = frontmatter(await readFile(join(repoRoot, "skills/wanderpage/SKILL.md"), "utf8"));
    expect(fields.name).toBe("wanderpage");
    expect(fields.description?.length).toBeGreaterThan(0);
    expect(fields.description!.length).toBeLessThanOrEqual(1024);
    const steps = ["inspect_photos", "create_draft", "preview_draft", "edit_draft", "publish_site"].map(tool =>
      body.indexOf(`\`${tool}\``)
    );
    expect(
      steps.every(index => index >= 0),
      steps.join()
    ).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(body).toMatch(/never identify a person/i);
    expect(body).toMatch(/keep the chosen location precision/i);
    expect(body).toMatch(/never publish when the scan reports findings/i);
  });
});

// @verifies ARCH-MCP
describe("pnpm mcpb", () => {
  // @verifies REQ-AGENT-2
  it("builds a valid desktop extension and the skill ZIP", async () => {
    await run("pnpm", ["--silent", "mcpb"], { cwd: repoRoot, env: cleanEnv(), maxBuffer: 10_000_000 });
    const bundle = join(repoRoot, "dist/mcpb/wanderpage.mcpb"),
      unpacked = await mkdtemp(join(tmpdir(), "wanderpage-mcpb-"));
    try {
      expect((await stat(bundle)).size).toBeGreaterThan(0);
      await run(process.execPath, [mcpbCli, "unpack", bundle, unpacked], { env: cleanEnv() });
      const validate = await run(process.execPath, [mcpbCli, "validate", join(unpacked, "manifest.json")], { env: cleanEnv() });
      expect(validate.stdout).toMatch(/validation passes/i);
      // Any non-zero exit rejects `run`, so reaching here means `mcpb validate` exited 0 for the repo manifest too.
      await run(process.execPath, [mcpbCli, "validate", join(repoRoot, "manifest.json")], { env: cleanEnv() });
      const packed = JSON.parse(await readFile(join(unpacked, "manifest.json"), "utf8")) as {
        version: string;
        tools: Array<{ name: string }>;
      };
      expect(packed.tools.map(tool => tool.name).sort()).toEqual([...toolNames].sort());
      const skillZip = await readFile(join(repoRoot, "dist/mcpb/wanderpage-skill.zip"));
      expect(skillZip.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
      expect(skillZip.includes("wanderpage/SKILL.md")).toBe(true);
    } finally {
      await rm(unpacked, { recursive: true, force: true });
    }
  }, 120_000);

  // @verifies REQ-AGENT-2
  it("ships the MCP server in the npm package the extension launches it from", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("mcp");
  });

  // @verifies REQ-AGENT-2
  it("launches the stdio server from the chosen project folder, whatever the working directory", async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, "manifest.json"), "utf8")) as Manifest;
    const launch = (userConfig: Record<string, string>) =>
      getMcpConfigForManifest({
        manifest,
        extensionPath: join(tmpdir(), "wanderpage-extension"),
        systemDirs: {
          HOME: homedir(),
          DESKTOP: join(homedir(), "Desktop"),
          DOCUMENTS: join(homedir(), "Documents"),
          DOWNLOADS: join(homedir(), "Downloads"),
        },
        userConfig,
        pathSeparator: sep,
      });
    // Without a project folder there is nothing to start, so Claude Desktop must ask for one first.
    expect(await launch({})).toBeUndefined();
    const config = await launch({ project: repoRoot });
    expect(config).toBeDefined();
    expect(config!.env).toEqual({ WANDERPAGE_WORKSPACE: repoRoot, OPENAI_API_KEY: "" });
    const elsewhere = await mkdtemp(join(tmpdir(), "wanderpage-cwd-"));
    try {
      const child = spawn(config!.command, config!.args ?? [], {
        cwd: elsewhere,
        env: cleanEnv(config!.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stderr.on("data", chunk => (stderr += String(chunk)));
      const listed = await new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no tools/list answer. stderr:\n${stderr}`)), 60_000);
        child.on("error", reject);
        child.on("close", code => reject(new Error(`server exited (${code}). stderr:\n${stderr}`)));
        child.stdout.on("data", chunk => {
          stdout += String(chunk);
          for (const line of stdout.split("\n").filter(Boolean)) {
            const message = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
            if (message.id === 1)
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`
              );
            if (message.id === 2) {
              clearTimeout(timer);
              resolve(message.result?.tools?.map(tool => tool.name) ?? []);
            }
          }
          stdout = stdout.endsWith("\n") ? "" : (stdout.split("\n").pop() ?? "");
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-test", version: "1" } } })}\n`
        );
      }).finally(() => child.kill());
      expect(listed.sort()).toEqual([...toolNames].sort());
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 90_000);
});

// @verifies ARCH-MCP
describe("the README", () => {
  // @verifies REQ-AGENT-3
  it("starts with Use Wanderpage in Claude, names all three install paths, and says Studio is frozen", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const sections = readme.split(/^## /m);
    expect(sections[1]?.split("\n")[0]?.trim()).toBe("Use Wanderpage in Claude");
    const first = sections[1]!;
    expect(first).toMatch(/\.mcpb/);
    expect(first).toMatch(/Claude Desktop/);
    expect(first).toMatch(/skill ZIP/i);
    expect(first).toMatch(/Customize > Skills/);
    expect(first).toMatch(/claude mcp add/);
    expect(first).toMatch(/Claude Code/);
    expect(first).toMatch(/Studio is frozen/i);
  });
});
