import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const run = promisify(execFile);
const workflow = await readFile(join(repoRoot, ".github/workflows/quality.yml"), "utf8");
const lines = workflow.split("\n");

// Returns the body of a job (jobs sit at 2 spaces) up to the next job or top-level key.
function jobBody(id: string): string {
  const start = lines.findIndex(line => line === `  ${id}:`);
  expect(start, `quality.yml has no ${id} job`).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line) || /^\S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

// Returns the job's `if:` condition (inline or block scalar), or "" when it has none.
function jobCondition(id: string): string {
  const body = jobBody(id).split("\n");
  const at = body.findIndex(line => /^ {4}if:/.test(line));
  if (at < 0) return "";
  const condition = [body[at]!.replace(/^ {4}if:\s*/, "")];
  for (const line of body.slice(at + 1)) {
    if (!/^ {6}/.test(line)) break;
    condition.push(line.trim());
  }
  return condition.join(" ");
}

// Returns a step's env block and its run script, unindented.
function step(name: string): { env: string; script: string } {
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  expect(start, `quality.yml has no ${name} step`).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}- name:/.test(line) || /^ {2}\S/.test(line)) break;
    body.push(line);
  }
  const runAt = body.findIndex(line => /^ {8}run: \|\s*$/.test(line));
  expect(runAt, `${name} step has no run block`).toBeGreaterThanOrEqual(0);
  const script = body
    .slice(runAt + 1)
    .filter(line => line === "" || line.startsWith("          "))
    .map(line => line.slice(10))
    .join("\n");
  return { env: body.slice(0, runAt).join("\n"), script };
}

type Coverage = { prCovered: string; prTestsCovered: string; stdout: string; ghCalls: string[] };

// A fake gh response: a body to print, or null to fail like an HTTP error.
type Reply = string | null;

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "wanderpage-pr-coverage-"));
});

afterAll(async () => {
  await removeTempWorkspace(workspace);
});

let caseCount = 0;

// Writes a fake gh reply script: call N of an endpoint gets replies[N-1] (the last reply repeats).
function replyScript(dir: string, endpoint: string, replies: Reply[]): string[] {
  const count = join(dir, `${endpoint}-count`);
  const out = [`  n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${count}"`];
  replies.forEach((reply, index) => {
    const test = index === replies.length - 1 ? "true" : `[ "$n" -eq ${index + 1} ]`;
    const action = reply === null ? 'echo "gh: HTTP 502" >&2; exit 1' : `cat "${join(dir, `${endpoint}-${index}.json`)}"; exit 0`;
    out.push(`  if ${test}; then ${action}; fi`);
  });
  return out;
}

// Runs the pr-coverage step with a fake gh that answers the pulls and actions/runs endpoints.
async function coverage(env: Record<string, string>, pulls: Reply, runs: Reply[] = [prRuns()]): Promise<Coverage> {
  const dir = join(workspace, `case-${(caseCount += 1)}`);
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const calls = join(dir, "gh-calls");
  for (const [endpoint, replies] of [
    ["pulls", [pulls]],
    ["runs", runs],
  ] as const) {
    for (const [index, reply] of replies.entries()) {
      if (reply !== null) await writeFile(join(dir, `${endpoint}-${index}.json`), reply);
    }
  }
  const fakeGh = [
    "#!/bin/bash",
    `printf '%s\\n' "$*" >> "${calls}"`,
    'case "$4" in',
    "*/pulls)",
    ...replyScript(dir, "pulls", [pulls]),
    "  ;;",
    "*/actions/runs)",
    ...replyScript(dir, "runs", runs),
    "  ;;",
    "esac",
    'echo "unexpected gh call: $*" >&2; exit 2',
    "",
  ].join("\n");
  await writeFile(join(bin, "gh"), fakeGh);
  await chmod(join(bin, "gh"), 0o755);
  const output = join(dir, "github-output");
  await writeFile(output, "");
  await writeFile(calls, "");
  const scriptPath = join(dir, "step.sh");
  await writeFile(scriptPath, step("Detect pull request coverage").script);
  const { stdout } = await run("bash", [scriptPath], {
    env: {
      NODE_ENV: "test",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_OUTPUT: output,
      REPOSITORY: "buildproven/wanderpage",
      REPOSITORY_OWNER: "buildproven",
      WORKFLOW_REF: "buildproven/wanderpage/.github/workflows/quality.yml@refs/heads/feature/x",
      HEAD_SHA: "abc123",
      EVENT_NAME: "push",
      REF_TYPE: "branch",
      PR_RUN_WAIT_SECONDS: "0",
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    (await readFile(output, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(line => line.split("=", 2) as [string, string])
  );
  const ghCalls = (await readFile(calls, "utf8")).split("\n").filter(Boolean);
  return { prCovered: outputs["pr-covered"]!, prTestsCovered: outputs["pr-tests-covered"]!, stdout, ghCalls };
}

const pull = (base: string, draft = false) => ({ number: 7, draft, base: { ref: base }, head: { ref: "feature/x" } });

// The actions/runs body: one run per entry, of quality.yml unless another path is given.
function prRuns(...entries: { path?: string; conclusion?: string | null }[]): string {
  const list = entries.length ? entries : [{}];
  return JSON.stringify({
    total_count: list.length,
    workflow_runs: list.map(({ path = ".github/workflows/quality.yml", conclusion = null }) => ({
      event: "pull_request",
      head_sha: "abc123",
      path,
      conclusion,
    })),
  });
}
const noRuns = JSON.stringify({ total_count: 0, workflow_runs: [] });
const pullsCall = (branch: string) => `api --method GET repos/buildproven/wanderpage/pulls -f state=open -f head=buildproven:${branch}`;
const runsCall = "api --method GET repos/buildproven/wanderpage/actions/runs -f event=pull_request -f head_sha=abc123";

// @verifies REQ-INST-3
describe("BUI-2181 quality checks run once per pull-request branch push", () => {
  it("skips the repeated jobs when a ready pull request into main has a pull_request run of the commit", async () => {
    const result = await coverage({ REF_NAME: "keel/BUI-2181" }, JSON.stringify([pull("main")]));
    expect(result).toMatchObject({ prCovered: "true", prTestsCovered: "true" });
    expect(result.stdout).toContain("A pull_request run checks abc123; this push skips the jobs that run there.");
    expect(result.ghCalls).toEqual([pullsCall("keel/BUI-2181"), runsCall]);
  });

  it("covers pull requests into master and develop too", async () => {
    for (const base of ["master", "develop"]) {
      const result = await coverage({ REF_NAME: "feature/x" }, JSON.stringify([pull(base)]));
      expect(result, base).toMatchObject({ prCovered: "true", prTestsCovered: "true" });
    }
  });

  it("keeps tests on the push run when the only pull request is a draft (its pull_request run skips tests)", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, JSON.stringify([pull("main", true)]));
    expect(result).toMatchObject({ prCovered: "true", prTestsCovered: "false" });
  });

  it("runs every check when no pull_request run starts, as for a pull request with a merge conflict", async () => {
    const result = await coverage({ REF_NAME: "feature/x", PR_RUN_WAIT_ATTEMPTS: "3" }, JSON.stringify([pull("main")]), [noRuns]);
    expect(result).toMatchObject({ prCovered: "false", prTestsCovered: "false" });
    expect(result.ghCalls).toEqual([pullsCall("feature/x"), runsCall, runsCall, runsCall]);
    expect(result.stdout).toContain(
      "No pull_request run of .github/workflows/quality.yml started for abc123 (a pull request with a merge conflict gets none); this push runs every check."
    );
  });

  it("waits for a pull_request run that starts after the push run", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, JSON.stringify([pull("main")]), [noRuns, noRuns, prRuns()]);
    expect(result).toMatchObject({ prCovered: "true", prTestsCovered: "true" });
    expect(result.ghCalls).toEqual([pullsCall("feature/x"), runsCall, runsCall, runsCall]);
  });

  it("waits about a minute by default before it runs every check", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, JSON.stringify([pull("main")]), [noRuns]);
    expect(result.ghCalls.filter(call => call === runsCall)).toHaveLength(12);
    expect(step("Detect pull request coverage").script).toContain('PR_RUN_WAIT_SECONDS="${PR_RUN_WAIT_SECONDS:-5}"');
  });

  it("does not count a cancelled pull_request run or a run of another workflow", async () => {
    const runs = prRuns({ conclusion: "cancelled" }, { path: ".github/workflows/release.yml" });
    const result = await coverage({ REF_NAME: "feature/x", PR_RUN_WAIT_ATTEMPTS: "1" }, JSON.stringify([pull("main")]), [runs]);
    expect(result).toMatchObject({ prCovered: "false", prTestsCovered: "false" });
  });

  it("counts a finished pull_request run that did not fail by cancellation", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, JSON.stringify([pull("main")]), [prRuns({ conclusion: "failure" })]);
    expect(result).toMatchObject({ prCovered: "true", prTestsCovered: "true" });
  });

  it("runs every check and warns when the pull_request run lookup fails", async () => {
    for (const runs of [null, '{"message":"Resource not accessible by integration"}']) {
      const result = await coverage({ REF_NAME: "feature/x" }, JSON.stringify([pull("main")]), [runs]);
      expect(result, String(runs)).toMatchObject({ prCovered: "false", prTestsCovered: "false" });
      expect(result.stdout).toContain("::warning::Could not list pull_request runs for abc123; this push runs every check.");
      expect(result.ghCalls).toEqual([pullsCall("feature/x"), runsCall]);
    }
  });

  it("runs every check on a push to a branch with no open pull request, without looking for runs", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, "[]");
    expect(result).toMatchObject({ prCovered: "false", prTestsCovered: "false" });
    expect(result.ghCalls).toEqual([pullsCall("feature/x")]);
  });

  it("runs every check when the open pull request targets a branch the pull_request trigger ignores", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, JSON.stringify([pull("release/1.x")]));
    expect(result).toMatchObject({ prCovered: "false", prTestsCovered: "false" });
    expect(result.ghCalls).toEqual([pullsCall("feature/x")]);
  });

  it("runs every check and warns when the pull request lookup fails", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, null);
    expect(result).toMatchObject({ prCovered: "false", prTestsCovered: "false" });
    expect(result.stdout).toContain("::warning::Could not list open pull requests for feature/x; this push runs every check.");
  });

  it("runs every check and warns when the lookup returns something other than a pull request list", async () => {
    const result = await coverage({ REF_NAME: "feature/x" }, '{"message":"Not Found"}');
    expect(result).toMatchObject({ prCovered: "false", prTestsCovered: "false" });
    expect(result.stdout).toContain("::warning::Could not list open pull requests");
  });

  it("does not look up pull requests for pushes to main, master or develop, tags, or other events", async () => {
    const cases: Record<string, string>[] = [
      { REF_NAME: "main" },
      { REF_NAME: "master" },
      { REF_NAME: "develop" },
      { REF_TYPE: "tag", REF_NAME: "v1.2.3" },
      { EVENT_NAME: "pull_request", REF_NAME: "7/merge" },
      { EVENT_NAME: "schedule", REF_NAME: "main" },
      { EVENT_NAME: "workflow_dispatch", REF_NAME: "feature/x" },
    ];
    for (const env of cases) {
      const result = await coverage(env, JSON.stringify([pull("main")]));
      expect(result, JSON.stringify(env)).toMatchObject({ prCovered: "false", prTestsCovered: "false", ghCalls: [] });
    }
  });

  it("passes the branch name to gh as data, not as shell code", async () => {
    const result = await coverage({ REF_NAME: "feature/$(touch pwned);x" }, "[]");
    expect(result.ghCalls).toEqual([pullsCall("feature/$(touch pwned);x")]);
    expect(step("Detect pull request coverage").script).not.toContain("${{");
  });

  it("reads github context through env and lists pull requests and runs with a read-only token", () => {
    const { env } = step("Detect pull request coverage");
    expect(env).toContain("id: pr-coverage");
    for (const name of ["GH_TOKEN", "EVENT_NAME", "REF_TYPE", "REF_NAME", "HEAD_SHA", "REPOSITORY", "REPOSITORY_OWNER", "WORKFLOW_REF"]) {
      expect(env, `${name} is not set from the github context`).toMatch(new RegExp(`^ {10}${name}: \\$\\{\\{ github\\.`, "m"));
    }
    expect(env).not.toMatch(/PR_RUN_WAIT/);
    const detect = jobBody("detect-maturity");
    expect(detect).toMatch(/^ {6}pr-covered: \$\{\{ steps\.pr-coverage\.outputs\.pr-covered \}\}$/m);
    expect(detect).toMatch(/^ {6}pr-tests-covered: \$\{\{ steps\.pr-coverage\.outputs\.pr-tests-covered \}\}$/m);
    expect(detect).toMatch(/^ {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}pull-requests: read$/m);
    expect(detect).not.toMatch(/write/);
    expect(jobCondition("detect-maturity")).toBe("");
  });

  it("skips only the jobs the pull_request run repeats", () => {
    expect(jobCondition("security")).toContain("needs.detect-maturity.outputs.pr-covered != 'true'");
    expect(jobCondition("documentation")).toContain("needs.detect-maturity.outputs.pr-covered != 'true'");
    expect(jobCondition("tests")).toContain("needs.detect-maturity.outputs.pr-tests-covered != 'true'");
    expect(jobCondition("tests")).not.toContain("outputs.pr-covered");
    expect(jobCondition("audit-report")).toMatch(/^github\.event_name == 'pull_request' &&/);
  });

  it("still parses install.ps1 on every push and keeps the summary gate strict", () => {
    const installer = jobBody("installer-parse");
    expect(jobCondition("installer-parse")).toBe("");
    expect(installer).not.toContain("pr-covered");
    expect(installer).not.toContain("needs:");
    const summary = jobBody("summary");
    expect(jobCondition("summary")).toBe("always()");
    for (const job of ["detect-maturity", "security", "audit-report", "tests", "documentation", "installer-parse"]) {
      expect(summary).toMatch(new RegExp(`^ {6}- ${job}$`, "m"));
    }
    expect(summary).toContain("detect-maturity:success) ;;");
    expect(summary).toContain("installer-parse:success) ;;");
  });

  it("reports the required summary check name only from a run that did every check", () => {
    const name = /^ {4}name: (.*)$/m.exec(jobBody("summary"))?.[1];
    expect(name).toBe(
      "${{ needs.detect-maturity.outputs.pr-covered == 'true' && 'summary (push; the pull_request run is the gate)' || 'summary' }}"
    );
  });

  it("says in the run summary why a push run skipped a job", async () => {
    const generate = step("Generate Check Summary");
    expect(generate.env).toMatch(/^ {10}PR_COVERED: \$\{\{ needs\.detect-maturity\.outputs\.pr-covered \}\}$/m);
    expect(generate.env).toMatch(/^ {10}PR_TESTS_COVERED: \$\{\{ needs\.detect-maturity\.outputs\.pr-tests-covered \}\}$/m);
    // The step text keeps expressions for detect-maturity statistics; stub them so bash can run it.
    const script = generate.script.replace(/\$\{\{[^}]*\}\}/g, "x");
    const dir = join(workspace, "summary-text");
    await mkdir(dir, { recursive: true });
    const render = async (env: Record<string, string>) => {
      const summaryFile = join(dir, `summary-${(caseCount += 1)}.md`);
      await writeFile(summaryFile, "");
      await run("bash", ["-c", script], {
        env: { NODE_ENV: "test", PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summaryFile, ...env },
      });
      return readFile(summaryFile, "utf8");
    };
    const skipped = { SECURITY_RESULT: "skipped", TESTS_RESULT: "skipped", DOCS_RESULT: "skipped" };
    const covered = await render({ ...skipped, PR_COVERED: "true", PR_TESTS_COVERED: "true" });
    for (const check of ["Security", "Tests", "Documentation"]) {
      expect(covered).toContain(`- ⏭️ ${check}: Skipped (the pull_request run checks this commit)`);
    }
    expect(covered).toContain("Note: a pull_request run checks this commit; this push run is not the required summary check (BUI-2181)");
    const draft = await render({ ...skipped, PR_COVERED: "true", PR_TESTS_COVERED: "false" });
    expect(draft).toContain("- ⏭️ Tests: Skipped (no test files)");
    const uncovered = await render({ ...skipped, PR_COVERED: "false", PR_TESTS_COVERED: "false" });
    expect(uncovered).toContain("- ⏭️ Security: Skipped (runs on schedule/manual trigger)");
    expect(uncovered).toContain("- ⏭️ Documentation: Skipped (not production-ready)");
    expect(uncovered).not.toContain("pull_request run");
  });

  it("keeps one concurrency group per workflow and ref", () => {
    expect(workflow).toMatch(
      /^concurrency:\n {2}group: quality-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true$/m
    );
  });
});
