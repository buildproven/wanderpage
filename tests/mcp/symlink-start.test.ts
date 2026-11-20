import { spawn } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempWorkspace, removeTempWorkspace, repoRoot } from "../helpers/workspace";

let workspace = "",
  linkedProject = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("mcp-symlink");
  await mkdir(join(workspace, "site"), { recursive: true });
  // The project folder the client names is a symlink, as under /tmp or /var on macOS.
  linkedProject = join(workspace, "linked-project");
  await symlink(repoRoot, linkedProject, "dir");
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

/** Starts the server the way the manifest does, sends `initialize`, and returns its standard output and exit code. */
function initialize(project: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, WANDERPAGE_WORKSPACE: join(workspace, "site") };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_") || name === "OPENAI_API_KEY") delete env[name];
    const child = spawn(
      process.execPath,
      [join(project, "node_modules/tsx/dist/cli.mjs"), "--tsconfig", join(project, "tsconfig.json"), join(project, "mcp/server.ts")],
      { env, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server did not answer in time. stderr:\n${stderr}`));
    }, 60_000);
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.includes("\n")) child.stdin.end();
    });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "symlink-test", version: "1" } },
      })}\n`
    );
  });
}

// @verifies DES-MCP-TOOLS, ARCH-MCP
describe("starting the MCP server through a symlinked project path", () => {
  // @verifies REQ-MCP-1
  it("serves MCP instead of exiting silently", async () => {
    const { stdout, stderr } = await initialize(linkedProject);
    const first = stdout.split("\n").find(Boolean);
    expect(first, `no response on standard output. stderr:\n${stderr}`).toBeDefined();
    expect(JSON.parse(first!)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: expect.any(Object) } });
  }, 90_000);
});
