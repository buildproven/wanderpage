import { execFileSync } from "node:child_process";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

let branch: string;
try {
  branch = git("symbolic-ref", "--short", "HEAD");
} catch {
  console.error("Not on a branch (detached HEAD). Tag from main after the release PR has merged.");
  process.exit(1);
}
if (branch !== "main") {
  console.error(`Tag from main after the release PR has merged (currently on "${branch}").`);
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
  console.error("Local main is not up to date with origin/main. Pull the merged release PR before tagging.");
  process.exit(1);
}

const version = execFileSync("node", ["-p", "require('./package.json').version"], { encoding: "utf8" }).trim();
const tag = `v${version}`;

const existingTags = git("tag", "--list", tag);
if (existingTags) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

git("tag", tag);
git("push", "origin", tag);
console.log(`Tagged and pushed ${tag} from main (${local}). release.yml will publish it.`);
