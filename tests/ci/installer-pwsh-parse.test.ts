import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const parserCall = "[System.Management.Automation.Language.Parser]::ParseFile";

type Step = { name: string; shell: string; run: string; text: string };
type Job = { id: string; runsOn: string; text: string; steps: Step[] };

// Reads the jobs and steps of a GitHub workflow by indentation (jobs at 2 spaces, steps at 6, step keys at 8).
function parseJobs(workflow: string): Job[] {
  const lines = workflow.split("\n"),
    start = lines.indexOf("jobs:");
  if (start < 0) throw new Error("workflow has no jobs: block");
  const jobs: { id: string; lines: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1]) jobs.push({ id: header[1], lines: [] });
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs.map(({ id, lines: body }) => {
    const stepsAt = body.indexOf("    steps:"),
      chunks: string[][] = [];
    if (stepsAt >= 0)
      for (const line of body.slice(stepsAt + 1)) {
        if (/^ {4}\S/.test(line)) break;
        if (/^ {6}- /.test(line)) chunks.push([line]);
        else chunks.at(-1)?.push(line);
      }
    return {
      id,
      runsOn: /^ {4}runs-on:\s*(.+)$/m.exec(body.join("\n"))?.[1]?.trim() ?? "",
      text: body.join("\n"),
      steps: chunks.map(parseStep),
    };
  });
}

function parseStep(chunk: string[]): Step {
  const text = chunk.join("\n").replace(/^ {6}- /, "        ");
  const runAt = chunk.findIndex(line => /^ {8}run:/.test(line.replace(/^ {6}- /, "        ")));
  let run = "";
  if (runAt >= 0) {
    const inline = /run:\s*(.*)$/.exec(chunk[runAt] ?? "")?.[1] ?? "";
    if (/^[|>]/.test(inline)) {
      const block: string[] = [];
      for (const line of chunk.slice(runAt + 1)) {
        if (line.trim() && !/^ {10}/.test(line)) break;
        block.push(line.slice(10));
      }
      run = block.join("\n").trimEnd();
    } else run = inline;
  }
  return {
    name: /^ {8}name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "",
    shell: /^ {8}shell:\s*(\S+)/m.exec(text)?.[1] ?? "",
    run,
    text,
  };
}

const loadJobs = async () => parseJobs(await readFile(join(repoRoot, ".github/workflows/quality.yml"), "utf8"));

function findParseStep(jobs: Job[]) {
  for (const job of jobs)
    for (const step of job.steps) if (step.run.includes(parserCall) && step.run.includes("install.ps1")) return { job, step };
  return undefined;
}

const hasPwsh = (() => {
  try {
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// @verifies DES-CLI-INSTALL, REQ-INST-1
describe("quality workflow parses install.ps1 with PowerShell", () => {
  it("has a pwsh step on an ubuntu job that parses install.ps1 and fails on parse errors", async () => {
    const found = findParseStep(await loadJobs());
    expect(found, `no step runs ${parserCall} on install.ps1`).toBeDefined();
    const { job, step } = found!;
    expect(job.runsOn).toMatch(/^ubuntu-/);
    expect(step.shell === "pwsh" || /^\s*pwsh\b/m.test(step.run), "step must run under pwsh").toBe(true);
    // The parser's error list ([ref] third argument) must be checked, and any error must exit non-zero.
    const errorsVar = /ParseFile\([^,]+,\s*\[ref\]\$\w+,\s*\[ref\](\$\w+)\)/.exec(step.run)?.[1];
    expect(errorsVar, "ParseFile must receive the error list as its third [ref] argument").toBeDefined();
    const escaped = errorsVar!.replace("$", "\\$");
    expect(step.run).toMatch(new RegExp(`if\\s*\\(\\s*${escaped}\\.Count\\s*-gt\\s*0\\s*\\)\\s*\\{[\\s\\S]*?exit\\s+1\\b`));
    // Parse only: the script is never invoked or dot-sourced, and a failure is never ignored.
    expect(step.run).not.toMatch(/(^|[\s;&.])\.?[\\/]?install\.ps1\s*($|[\s;])/m);
    expect(step.run).not.toMatch(/\biex\b|Invoke-Expression/i);
    expect(step.text).not.toMatch(/continue-on-error:\s*true/);
    // The job runs on every workflow run: no job or step condition.
    expect(job.text).not.toMatch(/^ {4}if:/m);
    expect(step.text).not.toMatch(/^ {8}if:/m);
  });

  it("keeps every existing job and step", async () => {
    const jobs = await loadJobs();
    const baseline: Record<string, string[]> = {
      "detect-maturity": [
        "Checkout code",
        "Detect change scope",
        "Setup pnpm",
        "Setup Node.js",
        "Detect Package Manager",
        "Setup Bun",
        "Detect Project Maturity",
        "Display Detection Report",
      ],
      security: [
        "Checkout code",
        "Setup pnpm",
        "Setup Node.js",
        "Setup Bun",
        "Install dependencies",
        "Verify dependency integrity",
        "Production dependency CVE gate",
        "Check for hardcoded secrets",
        "Security pattern detection",
      ],
      "audit-report": [
        "Checkout code",
        "Setup pnpm",
        "Setup Node.js",
        "Setup Bun",
        "Install dependencies",
        "Advisory full-tree dependency audit (non-blocking)",
        "Install semgrep CLI for vibe-audit",
        "QA Architect vibe-code audit",
        "Post audit report as PR comment",
      ],
      tests: [
        "Checkout code",
        "Setup pnpm",
        "Setup Node.js ${{ matrix.node-version }}",
        "Setup Bun",
        "Install dependencies",
        "Install Playwright Chromium",
        "Run affected tests",
        "Lint",
        "Format check",
        "Type check",
        "Build",
      ],
      documentation: [
        "Checkout code",
        "Setup pnpm",
        "Setup Node.js",
        "Setup Bun",
        "Install dependencies",
        "Documentation validation",
        "Documentation consistency and security audit freshness",
        "Package size and contents validation",
        "Detect web app",
        "Lighthouse CI",
        "Report Lighthouse Failures",
      ],
      summary: ["Generate Check Summary"],
    };
    for (const [id, steps] of Object.entries(baseline)) {
      const job = jobs.find(candidate => candidate.id === id);
      expect(job, `job ${id} is missing`).toBeDefined();
      expect(job!.steps.map(step => step.name)).toEqual(expect.arrayContaining(steps));
    }
  });

  // Runs where PowerShell exists (the CI tests job on ubuntu-latest); dev machines have none.
  it.skipIf(!hasPwsh)("passes on the shipped install.ps1 and fails on a broken copy", async () => {
    const { step } = findParseStep(await loadJobs())!;
    const sandbox = await mkdtemp(join(tmpdir(), "wanderpage-pwsh-parse-"));
    try {
      const stepScript = join(sandbox, "step.ps1"),
        broken = join(sandbox, "broken");
      await writeFile(stepScript, step.run);
      const runStep = (cwd: string) => execute("pwsh", ["-NoProfile", "-NonInteractive", "-File", stepScript], { cwd });
      await expect(runStep(repoRoot)).resolves.toBeDefined();
      await mkdir(broken);
      const shipped = await readFile(join(repoRoot, "install.ps1"), "utf8");
      await writeFile(join(broken, "install.ps1"), `${shipped}\n& { if ($true) {\n`);
      await expect(runStep(broken)).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("::error file=install.ps1") });
    } finally {
      await removeTempWorkspace(sandbox);
    }
  });
});
