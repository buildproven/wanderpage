// @design DES-REL-RELEASE
import { readFileSync, writeFileSync } from "node:fs";
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

const bump = process.argv[2];
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error(`Usage: tsx scripts/release-open-pr.ts <patch|minor|major>`);
  process.exit(1);
}

assertOnCleanUpToDateMain("Opening a release PR");

// Read every versioned file before npm bumps package.json, so a malformed file stops the release with the tree untouched.
let versioned: { path: string; file: { text: string; line: RegExp } }[];
try {
  versioned = versionedFiles.map(path => ({ path, file: topLevelVersion(path) }));
} catch (error) {
  console.error(`Release PR setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let branch: string | undefined;
try {
  const nextVersion = run("npm", ["version", "--no-git-tag-version", bump]).replace(/^v/, "");
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
