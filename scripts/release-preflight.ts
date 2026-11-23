// @design DES-REL-RELEASE
import { assertOnCleanUpToDateMain, git, run } from "./release-git";

/** The CI workflow whose success on main's HEAD stands in for a local full-suite run (BUI-2093, REQ-REL-02). */
const qualityWorkflow = "quality.yml";

interface WorkflowRun {
  status?: unknown;
  conclusion?: unknown;
  url?: unknown;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readQualityRuns(head: string): WorkflowRun[] {
  let output: string;
  try {
    output = run("gh", [
      "run",
      "list",
      "--workflow",
      qualityWorkflow,
      "--branch",
      "main",
      "--commit",
      head,
      "--limit",
      "20",
      "--json",
      "status,conclusion,url",
    ]);
  } catch (error) {
    fail(
      `Could not read the "quality" workflow runs for main's HEAD ${head} (${error instanceof Error ? error.message : String(error)}). Check that gh is installed and signed in.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`gh returned unreadable "quality" workflow runs for main's HEAD ${head}: ${output.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) fail(`gh returned unreadable "quality" workflow runs for main's HEAD ${head}: ${output.slice(0, 200)}`);
  return parsed as WorkflowRun[];
}

function describeRun(workflowRun: WorkflowRun): string {
  const state = workflowRun.status === "completed" ? `completed: ${String(workflowRun.conclusion)}` : String(workflowRun.status);
  return typeof workflowRun.url === "string" ? `${state} (${workflowRun.url})` : state;
}

assertOnCleanUpToDateMain("A release");

const head = git("rev-parse", "HEAD");
const runs = readQualityRuns(head);
const passed = runs.find(workflowRun => workflowRun.status === "completed" && workflowRun.conclusion === "success");
if (!passed) {
  const [latest] = runs;
  const state = latest === undefined ? "no run found" : `latest run ${describeRun(latest)}`;
  fail(`main's HEAD ${head} has no successful "quality" workflow run (${state}). Wait for CI to pass on main before releasing.`);
}

console.log(
  `Release preflight passed: on main, clean, up to date with origin/main, and "quality" passed on ${head} (${describeRun(passed)}).`
);
