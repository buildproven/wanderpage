import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace, repoRoot } from "../helpers/workspace";

type Config = { mcpServers: { wanderpage: { command: string; args: string[]; env: Record<string, string> } } };

let workspace = "",
  photos = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("mcp-stdio");
  // No GPS and hidden location privacy keep the run offline; no key means the deterministic basic edit.
  photos = await createPhotoFolder(workspace, { count: 4, gps: false });
  await mkdir(join(workspace, "site"), { recursive: true });
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

async function documentedConfig() {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8"),
    block = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]!).find(text => text.includes("mcpServers"));
  if (!block) throw new Error("README.md has no Claude Desktop mcpServers example");
  return (JSON.parse(block) as Config).mcpServers.wanderpage;
}

/** Runs the server, sends each request after the previous response, and returns every standard-output line. */
function converse(command: string, args: string[], env: NodeJS.ProcessEnv, requests: object[]) {
  return new Promise<{ lines: string[]; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    let buffer = "",
      stderr = "",
      sent = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server did not answer in time. stderr:\n${stderr}`));
    }, 90_000);
    const sendNext = () => {
      const next = requests[sent++];
      if (next) child.stdin.write(`${JSON.stringify(next)}\n`);
      else child.stdin.end();
    };
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts.filter(Boolean)) {
        lines.push(line);
        if (/"id"\s*:/.test(line) && /"(result|error)"\s*:/.test(line)) sendNext();
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      if (buffer) lines.push(buffer);
      resolve({ lines, stderr });
    });
    sendNext();
  });
}

// @verifies DES-MCP-TOOLS, ARCH-MCP
describe("the documented Claude Desktop command", () => {
  // @verifies REQ-MCP-1
  it("writes only JSON-RPC messages to standard output, even while the pipeline logs", async () => {
    const config = await documentedConfig();
    expect(config.args).toContain("--silent");
    const args = config.args.map(arg => (arg === "/path/to/wanderpage" ? repoRoot : arg));
    const env: NodeJS.ProcessEnv = { ...process.env, ...config.env, WANDERPAGE_WORKSPACE: join(workspace, "site") };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_") || name === "OPENAI_API_KEY") delete env[name];
    const { lines, stderr } = await converse(config.command, args, env, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_draft", arguments: { folder: photos, people: "include", locationPrivacy: "hidden", title: "Stdio" } },
      },
    ]);
    expect(lines.length, stderr).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(JSON.parse(line), line).toMatchObject({ jsonrpc: "2.0" });
    const answer = lines
      .map(line => JSON.parse(line) as { id?: number; result?: { isError?: boolean; content: Array<{ text: string }> } })
      .find(m => m.id === 2);
    expect(answer?.result?.isError, answer?.result?.content[0]?.text).not.toBe(true);
    expect(JSON.parse(answer!.result!.content[0]!.text).slug).toBe("stdio");
    // The pipeline's progress output went to standard error instead.
    expect(stderr).toMatch(/Wanderpage/);
  }, 120_000);
});
