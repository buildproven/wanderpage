import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

const workflowsDir = join(repoRoot, ".github/workflows");
const parserCall = "[System.Management.Automation.Language.Parser]::ParseFile";

type Workflow = { file: string; text: string; lines: string[] };

async function loadWorkflows(): Promise<Workflow[]> {
  const files = (await readdir(workflowsDir)).filter(name => /\.ya?ml$/.test(name)).sort();
  return Promise.all(
    files.map(async file => {
      const text = await readFile(join(workflowsDir, file), "utf8");
      return { file, text, lines: text.split("\n") };
    })
  );
}

// Returns the lines under a top-level key (`on:` or `jobs:`) up to the next top-level key.
function topLevel(lines: string[], key: string): string[] {
  const start = lines.findIndex(line => new RegExp(`^${key}:`).test(line));
  if (start < 0) return [];
  const body = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return body;
}

// Splits the jobs: block into job id -> job body text (jobs at 2 spaces), with trailing blank lines removed.
function jobs(workflow: Workflow): Map<string, string> {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of topLevel(workflow.lines, "jobs").slice(1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1]) out.set(header[1], (current = []));
    else if (/^ {2}#/.test(line)) current = undefined;
    else current?.push(line);
  }
  return new Map([...out].map(([id, body]) => [id, body.join("\n").trimEnd()]));
}

// True when the workflow runs on a push to any branch and any path: no branch, tag, or path filter.
function runsOnEveryPush(workflow: Workflow): boolean {
  const on = topLevel(workflow.lines, "on");
  const inline = /^on:\s*(.*?)\s*$/.exec(on[0] ?? "")?.[1] ?? "";
  if (inline) return inline === "push" || /^\[(?:.*,\s*)?push(?:\s*,.*)?\]$/.test(inline);
  const at = on.findIndex(line => /^ {2}push:/.test(line));
  if (at < 0) return false;
  if (!/^ {2}push:\s*(?:#.*)?$/.test(on[at]!)) return false;
  const filters = [];
  for (const line of on.slice(at + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    if (line.trim() && !line.trim().startsWith("#")) filters.push(line.trim());
  }
  return filters.length === 0;
}

const parsesInstaller = (job: string) => job.includes(parserCall) && job.includes("install.ps1");

// @verifies REQ-INST-3
describe("CI parses the Windows installer on every push", () => {
  it("has a workflow that runs on a push to any branch and parses install.ps1", async () => {
    const workflows = await loadWorkflows();
    const onEveryPush = workflows.filter(workflow => runsOnEveryPush(workflow) && [...jobs(workflow).values()].some(parsesInstaller));
    expect(
      onEveryPush.map(workflow => workflow.file),
      "no workflow parses install.ps1 on a push without branch or path filters"
    ).not.toEqual([]);
  });

  it("runs the same installer-parse job as the required quality workflow, so the two cannot drift", async () => {
    const workflows = await loadWorkflows();
    const quality = workflows.find(workflow => workflow.file === "quality.yml");
    expect(quality, "quality.yml is missing").toBeDefined();
    const required = jobs(quality!).get("installer-parse");
    expect(required, "quality.yml has no installer-parse job").toBeDefined();
    expect(parsesInstaller(required!)).toBe(true);
    for (const workflow of workflows.filter(candidate => candidate.file !== "quality.yml" && runsOnEveryPush(candidate)))
      for (const [id, job] of jobs(workflow))
        if (parsesInstaller(job)) {
          expect(id, `${workflow.file} job name`).toBe("installer-parse");
          expect(job, `${workflow.file} installer-parse differs from quality.yml`).toBe(required);
        }
  });

  it("keeps the push workflow read-only and its result counted", async () => {
    const workflows = await loadWorkflows();
    for (const workflow of workflows.filter(candidate => candidate.file !== "quality.yml" && runsOnEveryPush(candidate))) {
      if (![...jobs(workflow).values()].some(parsesInstaller)) continue;
      expect(topLevel(workflow.lines, "permissions").join("\n")).toMatch(/^ {2}contents:\s*read\s*$/m);
      expect(workflow.text).not.toMatch(/continue-on-error/);
      expect(workflow.text).not.toMatch(/^ {4}if:/m);
    }
  });

  it("detects push filters and inline triggers", () => {
    const parse = (text: string) => runsOnEveryPush({ file: "x.yml", text, lines: text.split("\n") });
    expect(parse("on:\n  push:\n  pull_request:\n")).toBe(true);
    expect(parse("on:\n  push: # any branch\njobs:\n")).toBe(true);
    expect(parse("on: push\n")).toBe(true);
    expect(parse("on: [pull_request, push]\n")).toBe(true);
    expect(parse("on:\n  push:\n    branches: [main]\n")).toBe(false);
    expect(parse("on:\n  push:\n    paths-ignore:\n      - '**.md'\n")).toBe(false);
    expect(parse("on:\n  push:\n    tags: ['v*']\n")).toBe(false);
    expect(parse("on:\n  pull_request:\n")).toBe(false);
    expect(parse("on: pull_request\n")).toBe(false);
  });
});
