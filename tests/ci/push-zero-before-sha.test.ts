import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

const workflow = await readFile(join(repoRoot, ".github/workflows/quality.yml"), "utf8");

function stepBody(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  expect(start, `quality.yml has no ${name} step`).toBeGreaterThanOrEqual(0);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}- name:/.test(line) || /^ {2}\S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

function expectBaseValidationBeforeUse(step: string, firstUse: string): void {
  const validation = 'git cat-file -e "$BASE_SHA^{commit}"';
  expect(step, `step does not validate github.event.before as a commit`).toContain(validation);
  expect(step, `step no longer has its valid-base incremental path`).toContain(firstUse);
  expect(step.indexOf(validation), `step uses github.event.before before validating it`).toBeLessThan(step.indexOf(firstUse));
}

// @verifies REQ-INST-3
describe("BUI-1770 quality checks on a new branch push", () => {
  it("falls back to a full secrets scan when github.event.before is the all-zero SHA", () => {
    const step = stepBody("Check for hardcoded secrets");
    expectBaseValidationBeforeUse(step, '"$BASE_SHA..$HEAD_SHA"');
    expect(step).toContain('echo "No valid comparison base; scanning the complete repository history."');
  });

  it("falls back to a full Semgrep scan when github.event.before is the all-zero SHA", () => {
    const step = stepBody("Security pattern detection");
    expectBaseValidationBeforeUse(step, 'git diff --name-only "$BASE_SHA" "$HEAD_SHA"');
    expect(step).toContain("No valid comparison base; scanning the complete worktree.");
  });

  it("falls back to the complete test command when github.event.before is the all-zero SHA", () => {
    const step = stepBody("Run affected tests");
    expectBaseValidationBeforeUse(step, 'git diff --name-only "$BASE_SHA" "$HEAD_SHA"');
    expect(step).toContain("No valid comparison base. Running the complete test suite.");
    expect(step).toContain("timeout 300 pnpm run test");
  });
});
