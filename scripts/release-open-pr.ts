// @design DES-REL-RELEASE
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { compareVersions } from "../bin/local-edition.js";
import { assertOnCleanUpToDateMain, git, run } from "./release-git";

/** Files besides package.json whose top-level "version" must equal the package version (REQ-PLUGIN-1, the .mcpb manifest). */
const versionedFiles = ["manifest.json", ".claude-plugin/plugin.json"];

/** Finds the top-level "version" line of a two-space-indented JSON file, so a bump rewrites only that line and keeps the layout. */
function topLevelVersion(path: string): { text: string; line: RegExp } {
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error(`${path} has no top-level "version" string.`);
  const line = /^ {2}"version": "[^"]*"/m;
  const matches = text.match(new RegExp(line.source, "gm")) ?? [];
  if (matches.length !== 1)
    throw new Error(`${path} must have exactly one top-level "version" line at two-space indent; found ${matches.length}.`);
  return { text, line };
}

function writeVersion(path: string, file: { text: string; line: RegExp }, version: string): void {
  const updated = file.text.replace(file.line, `  "version": ${JSON.stringify(version)}`);
  if ((JSON.parse(updated) as { version?: unknown }).version !== version) throw new Error(`Could not set ${path} version to ${version}.`);
  writeFileSync(path, updated);
}

type Bump = "patch" | "minor" | "major";

/** The version `npm version <bump>` will produce. Only a plain MAJOR.MINOR.PATCH is accepted, so the plan cannot differ from npm's result. */
function plannedVersion(current: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`package.json version "${current}" is not MAJOR.MINOR.PATCH, so the next ${bump} version is unclear.`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Why CHANGELOG.md is not ready for `version`, or undefined when it is: it needs a `## <version>` entry, and its first entry must not be older
 * than `version` (the rule the CHANGELOG test applies on push, BUI-2137), so the release stops before it bumps, branches or commits.
 */
function changelogProblem(changelog: string, version: string): string | undefined {
  const fix = `Add a "## ${version}" entry to CHANGELOG.md on main first (in its own PR), then run the release again.`;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^## ${escaped}(?=\\s|$)`, "m").test(changelog)) return `CHANGELOG.md has no entry for ${version}. ${fix}`;
  const first = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/m.exec(changelog)?.[1];
  if (first === undefined || compareVersions(first, version) < 0)
    return `CHANGELOG.md's first entry is ${first ?? "not a version"}, older than the next version ${version}. ${fix}`;
  return undefined;
}

const bump = process.argv[2];
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error(`Usage: tsx scripts/release-open-pr.ts <patch|minor|major>`);
  process.exit(1);
}

assertOnCleanUpToDateMain("Opening a release PR");

// Read every versioned file and check the CHANGELOG before npm bumps package.json, so a malformed file or a missing CHANGELOG entry stops
// the release with the tree untouched.
let versioned: { path: string; file: { text: string; line: RegExp } }[];
let expectedVersion: string;
try {
  versioned = versionedFiles.map(path => ({ path, file: topLevelVersion(path) }));
  expectedVersion = plannedVersion(String((JSON.parse(readFileSync("package.json", "utf8")) as { version?: unknown }).version), bump);
  // A missing CHANGELOG.md has no entry for the next version either, so it gets the same message.
  const problem = changelogProblem(existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "", expectedVersion);
  if (problem) throw new Error(problem);
} catch (error) {
  console.error(`Release PR setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let branch: string | undefined;
try {
  const nextVersion = run("npm", ["version", "--no-git-tag-version", bump]).replace(/^v/, "");
  if (nextVersion !== expectedVersion)
    throw new Error(`npm bumped to ${nextVersion}, but CHANGELOG.md was checked for ${expectedVersion}.`);
  for (const { path, file } of versioned) writeVersion(path, file, nextVersion);
  branch = `chore/release-v${nextVersion}`;

  git("checkout", "-b", branch);
  git("add", "package.json", ...versionedFiles);
  git("commit", "-m", `chore: release v${nextVersion}`);
  git("push", "-u", "origin", branch);

  const prUrl = run("gh", [
    "pr",
    "create",
    "--title",
    `chore: release v${nextVersion}`,
    "--body",
    `Version bump for the next npm release. Merge this normally (any merge strategy is fine — \`pnpm release:tag\` tags main's HEAD after merge, not this branch's commit), then run:\n\n\`\`\`bash\ngit checkout main && git pull\npnpm release:tag\n\`\`\`\n`,
  ]);

  console.log(`\nOpened release PR: ${prUrl}`);
  console.log("Next steps:");
  console.log("  1. Get this PR reviewed and merged.");
  console.log("  2. git checkout main && git pull");
  console.log("  3. pnpm release:tag");
} catch (error) {
  console.error(`\nRelease PR setup failed: ${error instanceof Error ? error.message : String(error)}`);
  if (branch) {
    console.error(`Left on branch "${branch}" — recover with:`);
    console.error(`  git checkout main && git branch -D ${branch}`);
    console.error(`(and delete the remote branch too if it was already pushed: git push origin --delete ${branch})`);
  }
  process.exit(1);
}
