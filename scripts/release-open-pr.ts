import { execFileSync } from "node:child_process";

const bump = process.argv[2];
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error(`Usage: tsx scripts/release-open-pr.ts <patch|minor|major>`);
  process.exit(1);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const branch = `chore/release-v${bump}-${Date.now()}`;
git("checkout", "-b", branch);

const nextVersion = run("npm", ["version", "--no-git-tag-version", bump]).replace(/^v/, "");
git("add", "package.json");
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
