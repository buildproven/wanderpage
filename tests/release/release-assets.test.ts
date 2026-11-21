import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/workspace";

const desktopExtension = "dist/mcpb/wanderpage.mcpb";
const skillZip = "dist/mcpb/wanderpage-skill.zip";
const latestDownload = "https://github.com/buildproven/wanderpage/releases/latest/download/";

// Splits the release job into its steps, so each assertion reads only the step it is about.
function releaseSteps(workflow: string): string[] {
  const stepsAt = workflow.indexOf("    steps:\n");
  expect(stepsAt, "release.yml has no steps").toBeGreaterThan(-1);
  return workflow
    .slice(stepsAt)
    .split(/^ {6}- /m)
    .slice(1);
}

const stepIndex = (steps: string[], pattern: RegExp) => steps.findIndex(step => pattern.test(step));

// @verifies ARCH-RELEASE, REQ-REL-02, REQ-AGENT-2, REQ-AGENT-3
describe("release assets (BUI-2014)", () => {
  it("REQ-AGENT-2 builds the desktop extension and skill ZIP after the checks and before npm publish", async () => {
    const steps = releaseSteps(await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8"));
    const check = stepIndex(steps, /^run: pnpm check$/m);
    const build = stepIndex(steps, /^\s*run: pnpm mcpb$/m);
    const publish = stepIndex(steps, /npm publish --provenance --access public/);
    expect(check).toBeGreaterThan(-1);
    expect(build, "release.yml has no `pnpm mcpb` step").toBeGreaterThan(check);
    expect(publish, "a failed `pnpm mcpb` must stop the release before npm publish").toBeGreaterThan(build);
  });

  it("REQ-AGENT-2 attaches dist/mcpb/wanderpage.mcpb and the skill ZIP to the GitHub release and fails if either is missing", async () => {
    const steps = releaseSteps(await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8"));
    const release = steps.find(step => step.includes("uses: softprops/action-gh-release@"));
    expect(release, "release.yml has no GitHub release step").toBeDefined();
    if (!release) throw new Error("release.yml has no GitHub release step");
    const files = /^ {10}files: \|\n((?: {12}\S.*\n)+)/m.exec(release);
    expect(files, "the GitHub release step lists no files").not.toBeNull();
    const listed = (files?.[1] ?? "")
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    expect(listed).toEqual([desktopExtension, skillZip]);
    expect(release).toMatch(/^ {10}fail_on_unmatched_files: true$/m);
    expect(release).toContain(`${latestDownload}wanderpage.mcpb`);
    expect(release).toContain(`${latestDownload}wanderpage-skill.zip`);
  });

  it("REQ-AGENT-3 tells npx users to download both files from the latest GitHub release", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const claudeSection = readme.split(/^## /m).find(section => section.startsWith("Use Wanderpage in Claude"));
    expect(claudeSection).toBeDefined();
    const plain = (claudeSection ?? "").replace(/\s+/g, " ");
    expect(plain).toContain(`(${latestDownload}wanderpage.mcpb)`);
    expect(plain).toContain(`(${latestDownload}wanderpage-skill.zip)`);
    // The checkout route stays documented for contributors.
    expect(plain).toContain("pnpm mcpb");
  });
});
