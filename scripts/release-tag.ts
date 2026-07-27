import { execFileSync } from "node:child_process";
import { assertOnCleanUpToDateMain, git } from "./release-git";

assertOnCleanUpToDateMain("Tagging a release");

const version = execFileSync("node", ["-p", "require('./package.json').version"], { encoding: "utf8" }).trim();
const tag = `v${version}`;

const localTags = git("tag", "--list", tag);
if (localTags) {
  console.error(`Tag ${tag} already exists locally.`);
  process.exit(1);
}

const remoteTags = git("ls-remote", "--tags", "origin", tag);
if (remoteTags) {
  console.error(`Tag ${tag} already exists on origin.`);
  process.exit(1);
}

git("tag", tag);
try {
  git("push", "origin", tag);
} catch (error) {
  console.error(`\nFailed to push tag ${tag}: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`The local tag was created — delete it with "git tag -d ${tag}" if you want to retry cleanly.`);
  process.exit(1);
}

const head = git("rev-parse", "main");
console.log(`Tagged and pushed ${tag} from main (${head}). release.yml will publish it.`);
