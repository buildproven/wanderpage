// @design DES-REL-RELEASE
import { execFileSync } from "node:child_process";
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

// node_modules that do not match pnpm-lock.yaml make the pre-push tests fail after the bump (2026-11-23, BUI-2137). With a frozen lockfile,
// pnpm installs only what differs and never rewrites the lockfile; a failed install stops the release before anything is bumped.
try {
  execFileSync("pnpm", ["install", "--frozen-lockfile"], { stdio: ["ignore", "inherit", "inherit"] });
} catch (error) {
  fail(
    `"pnpm install --frozen-lockfile" failed (${error instanceof Error ? error.message : String(error)}), so node_modules may not match pnpm-lock.yaml. Fix the install on main, then release again.`
  );
}

console.log(
  `Release preflight passed: on main, clean, up to date with origin/main, "quality" passed on ${head} (${describeRun(passed)}), and node_modules match pnpm-lock.yaml.`
);
