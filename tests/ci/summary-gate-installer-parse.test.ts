import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const workflow = await readFile(join(repoRoot, ".github/workflows/quality.yml"), "utf8");

// Splits the jobs: block of the workflow into job id -> job body lines (jobs at 2 spaces).
function jobs(): Map<string, string[]> {
  const lines = workflow.split("\n"),
    out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1]) out.set(header[1], (current = []));
    else if (/^\S/.test(line)) break;
    else current?.push(line);
  }
  return out;
}

function summaryNeeds(summary: string[]): string[] {
  const at = summary.indexOf("    needs:");
  const needs: string[] = [];
  for (const line of summary.slice(at + 1)) {
    const item = /^ {6}- ([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (!item?.[1]) break;
    needs.push(item[1]);
  }
  return needs;
}

// Returns the env map and run body of the summary step that enforces the needed jobs' results.
function enforceStep(summary: string[]) {
  const start = summary.findIndex(line => /^ {6}- name: Enforce check results\s*$/.test(line));
  expect(start, "summary has no Enforce check results step").toBeGreaterThanOrEqual(0);
  const step: string[] = [];
  for (const line of summary.slice(start + 1)) {
    if (/^ {6}- /.test(line)) break;
    step.push(line);
  }
  const env: Record<string, string> = {};
  const envAt = step.indexOf("        env:");
  for (const line of step.slice(envAt + 1)) {
    const entry = /^ {10}([A-Z_]+):\s*\$\{\{\s*needs\.([A-Za-z0-9_-]+)\.result\s*\}\}\s*$/.exec(line);
    if (!entry?.[1] || !entry[2]) break;
    env[entry[1]] = entry[2];
  }
  const runAt = step.findIndex(line => /^ {8}run: \|\s*$/.test(line));
  const body: string[] = [];
  for (const line of step.slice(runAt + 1)) {
    if (line.trim() && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  return { env, run: body.join("\n") };
}

// Runs the enforce step in bash with each needed job's result set from `results` (default success).
async function enforce(results: Record<string, string>) {
  const summary = jobs().get("summary")!;
  const { env, run } = enforceStep(summary);
  const jobEnv = Object.fromEntries(Object.entries(env).map(([name, job]) => [name, results[job] ?? "success"]));
  return execute("bash", ["-e", "-c", run], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, GITHUB_STEP_SUMMARY: "/dev/null", ...jobEnv },
  });
}

// @verifies REQ-INST-3
describe("the required summary check counts the Windows installer parse", () => {
  it("needs every other job, so none can fail without the summary seeing it", () => {
    const all = jobs();
    const summary = all.get("summary");
    expect(summary, "quality.yml has no summary job").toBeDefined();
    expect(summaryNeeds(summary!)).toContain("installer-parse");
    expect([...all.keys()].filter(id => id !== "summary" && !summaryNeeds(summary!).includes(id))).toEqual([]);
  });

  it("reads the result of every needed job in the enforce step", () => {
    const summary = jobs().get("summary")!;
    const { env, run } = enforceStep(summary);
    for (const job of summaryNeeds(summary)) {
      const name = Object.entries(env).find(([, needed]) => needed === job)?.[0];
      expect(name, `enforce step has no env for needs.${job}.result`).toBeDefined();
      expect(run).toContain(`check ${job} "$${name}"`);
    }
  });

  it("passes when installer-parse succeeds and fails when it fails, is cancelled, or is skipped", async () => {
    await expect(enforce({})).resolves.toMatchObject({ stdout: expect.stringContaining("Quality gate passed") });
    for (const result of ["failure", "cancelled", "skipped"])
      await expect(enforce({ "installer-parse": result }), `installer-parse ${result}`).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining(`installer-parse(${result})`),
      });
  });
});
