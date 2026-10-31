import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const workflow = await readFile(join(repoRoot, ".github/workflows/quality.yml"), "utf8");

// Splits a block of lines at each line that starts with `indent` spaces followed by `marker`.
function blocks(lines: string[], indent: number, marker: RegExp): string[][] {
  const out: string[][] = [];
  for (const line of lines) {
    if (new RegExp(`^ {${indent}}${marker.source}`).test(line)) out.push([line]);
    else if (/^\S/.test(line)) break;
    else out.at(-1)?.push(line);
  }
  return out;
}

function parseStep() {
  const lines = workflow.split("\n"),
    jobs = blocks(lines.slice(lines.indexOf("jobs:") + 1), 2, /[\w-]+:\s*$/);
  for (const job of jobs)
    for (const step of blocks(job.slice(job.indexOf("    steps:") + 1), 6, /- /)) {
      const text = step.join("\n");
      if (!text.includes("Language.Parser]::ParseFile") || !text.includes("install.ps1")) continue;
      const runAt = step.findIndex(line => /^ {8}run: \|\s*$/.test(line));
      const body: string[] = [];
      for (const line of step.slice(runAt + 1)) {
        if (line.trim() && !line.startsWith(" ".repeat(10))) break;
        body.push(line.slice(10));
      }
      return { job: job.join("\n"), step: text, run: body.join("\n").trimEnd() };
    }
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

// @verifies REQ-INST-3
describe("CI checks the Windows installer's syntax", () => {
  it("parses install.ps1 with PowerShell on a Linux runner on every pull request and push", () => {
    expect(workflow).toMatch(/^ {2}pull_request:/m);
    expect(workflow).toMatch(/^ {2}push:/m);
    const found = parseStep();
    expect(found, "no workflow step parses install.ps1").toBeDefined();
    const { job, step, run } = found!;
    expect(job).toMatch(/^ {4}runs-on:\s*ubuntu-/m);
    expect(step).toMatch(/^ {8}shell:\s*pwsh\s*$/m);
    expect(run).toMatch(/Join-Path \$PWD 'install\.ps1'/);
    // No condition and no ignored failure: the check runs and counts on every workflow run.
    expect(job).not.toMatch(/^ {4}if:/m);
    expect(step).not.toMatch(/^ {8}if:/m);
    expect(step).not.toMatch(/continue-on-error/);
  });

  it("never runs the script and fails with the line and column of each parse error", () => {
    const { run } = parseStep()!;
    expect(run).not.toMatch(/\biex\b|Invoke-Expression|Invoke-Command|Start-Process/i);
    expect(run).not.toMatch(/^\s*(?:&|\.)\s*\S*install\.ps1/m);
    expect(run).toMatch(/ParseFile\(\$path,\s*\[ref\]\$\w+,\s*\[ref\]\$parseErrors\)/);
    expect(run).toMatch(/if \(\$parseErrors\.Count -gt 0\) \{[\s\S]*?exit 1\b/);
    expect(run).toContain(
      "::error file=install.ps1,line=$($parseError.Extent.StartLineNumber),col=$($parseError.Extent.StartColumnNumber)::"
    );
  });

  // Runs where PowerShell exists (the CI tests job on ubuntu-latest); dev machines have none.
  it.skipIf(!hasPwsh)("accepts the shipped script and rejects a truncated copy", { timeout: 60_000 }, async () => {
    const { run } = parseStep()!;
    const sandbox = await mkdtemp(join(tmpdir(), "wanderpage-installer-parse-"));
    try {
      const script = join(sandbox, "step.ps1"),
        broken = join(sandbox, "broken");
      await writeFile(script, run);
      const runStep = (cwd: string) => execute("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], { cwd });
      const shipped = await readFile(join(repoRoot, "install.ps1"), "utf8");
      await expect(runStep(repoRoot)).resolves.toMatchObject({ stdout: expect.stringContaining("install.ps1 parsed with no errors.") });
      await mkdir(broken);
      // An unclosed block at the end of the file: the error names a line inside the file.
      await writeFile(join(broken, "install.ps1"), `${shipped}\n& { if ($true) {\n`);
      await expect(runStep(broken)).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringMatching(/::error file=install\.ps1,line=\d+,col=\d+::/),
      });
    } finally {
      await removeTempWorkspace(sandbox);
    }
  });
});
