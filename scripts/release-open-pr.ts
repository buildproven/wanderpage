import { assertOnCleanUpToDateMain, git, run } from "./release-git";

const bump = process.argv[2];
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error(`Usage: tsx scripts/release-open-pr.ts <patch|minor|major>`);
  process.exit(1);
}

assertOnCleanUpToDateMain("Opening a release PR");

let branch: string | undefined;
try {
  const nextVersion = run("npm", ["version", "--no-git-tag-version", bump]).replace(/^v/, "");
  branch = `chore/release-v${nextVersion}`;

  git("checkout", "-b", branch);
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
} catch (error) {
  console.error(`\nRelease PR setup failed: ${error instanceof Error ? error.message : String(error)}`);
  if (branch) {
    console.error(`Left on branch "${branch}" — recover with:`);
    console.error(`  git checkout main && git branch -D ${branch}`);
    console.error(`(and delete the remote branch too if it was already pushed: git push origin --delete ${branch})`);
  }
  process.exit(1);
}
