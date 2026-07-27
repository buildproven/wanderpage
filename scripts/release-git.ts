import { execFileSync } from "node:child_process";

export function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

export function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

/** Verifies the repo is on `main`, has a clean working tree, and matches `origin/main`. Exits the process on failure. */
export function assertOnCleanUpToDateMain(context: string): void {
  let branch: string;
  try {
    branch = git("symbolic-ref", "--short", "HEAD");
  } catch {
    console.error(`Not on a branch (detached HEAD). ${context} must run from main.`);
    process.exit(1);
  }
  if (branch !== "main") {
    console.error(`${context} must run from main (currently on "${branch}").`);
    process.exit(1);
  }

  const status = git("status", "--porcelain");
  if (status) {
    console.error("Working tree is not clean. Commit or stash changes first.");
    process.exit(1);
  }

  try {
    git("fetch", "origin", "main");
  } catch {
    console.error('Could not fetch "origin" — this needs an "origin" remote pointing at the canonical repo.');
    process.exit(1);
  }
  const local = git("rev-parse", "main");
  const remote = git("rev-parse", "origin/main");
  if (local !== remote) {
    console.error("Local main is not up to date with origin/main. Pull first.");
    process.exit(1);
  }
}
