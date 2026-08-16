import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironmentFile, loadStudioEnvironment } from "@/lib/studio/environment";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

describe("Studio environment", () => {
  const workspaces: string[] = [];
  const originalOpenAIKey = process.env.OPENAI_API_KEY,
    originalPort = process.env.WANDERPAGE_PORT;
  afterEach(async () => {
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
    if (originalPort === undefined) delete process.env.WANDERPAGE_PORT;
    else process.env.WANDERPAGE_PORT = originalPort;
    await Promise.all(workspaces.splice(0).map(removeTempWorkspace));
  });

  it("loads an API key from the generated project's .env.local without overriding a shell value", async () => {
    const workspace = await createTempWorkspace("studio-environment");
    workspaces.push(workspace);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, ".env.local"), "OPENAI_API_KEY=from-local-file\nWANDERPAGE_PORT=4400\n");

    delete process.env.OPENAI_API_KEY;
    delete process.env.WANDERPAGE_PORT;
    await loadStudioEnvironment(workspace);
    expect(process.env.OPENAI_API_KEY).toBe("from-local-file");
    expect(process.env.WANDERPAGE_PORT).toBe("4400");

    process.env.OPENAI_API_KEY = "shell";
    await loadStudioEnvironment(workspace);
    expect(process.env.OPENAI_API_KEY).toBe("shell");
  });

  it("loads an existing private env file without requiring it to be copied into the project", async () => {
    const workspace = await createTempWorkspace("studio-external-environment");
    workspaces.push(workspace);
    const envFile = join(workspace, "private.env");
    await writeFile(envFile, "OPENAI_API_KEY=from-existing-file\nWANDERPAGE_PORT=4401\n");

    delete process.env.OPENAI_API_KEY;
    delete process.env.WANDERPAGE_PORT;
    await loadEnvironmentFile(envFile);

    expect(process.env.OPENAI_API_KEY).toBe("from-existing-file");
    expect(process.env.WANDERPAGE_PORT).toBe("4401");
  });
});
