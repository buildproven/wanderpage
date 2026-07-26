import { execFileSync } from "node:child_process";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const branch = git("symbolic-ref", "--short", "HEAD");
if (branch !== "main") {
  console.error(`Releases must be cut from main (currently on "${branch}").`);
  process.exit(1);
}

const status = git("status", "--porcelain");
if (status) {
  console.error("Working tree is not clean. Commit or stash changes before releasing.");
  process.exit(1);
}

try {
  git("fetch", "origin", "main");
} catch {
  console.error('Could not fetch "origin" — releases require an "origin" remote pointing at the canonical repo.');
  process.exit(1);
}
const local = git("rev-parse", "main");
const remote = git("rev-parse", "origin/main");
if (local !== remote) {
  console.error("Local main is not up to date with origin/main. Pull before releasing.");
  process.exit(1);
}

console.log("Release preflight passed: on main, clean, up to date with origin/main.");
