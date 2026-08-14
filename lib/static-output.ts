import { randomUUID } from "node:crypto";
import { access, cp, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const priorPrefix = ".out-prior-";
const stagedPrefix = ".out-next-";

export async function recoverStaticOutput(root: string) {
  const output = join(root, "out"),
    entries = await readdir(root, { withFileTypes: true }),
    priors = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(priorPrefix)).map(entry => join(root, entry.name)),
    staged = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(stagedPrefix)).map(entry => join(root, entry.name));
  if (!(await exists(output)) && priors.length) {
    const newest = await newestPath(priors);
    await rename(newest, output);
    priors.splice(priors.indexOf(newest), 1);
  }
  await Promise.all([...priors, ...staged].map(path => rm(path, { recursive: true, force: true })));
}

export async function replaceStaticOutput(root: string, builtOutput: string) {
  await recoverStaticOutput(root);
  const output = join(root, "out"),
    stagedOutput = join(root, `${stagedPrefix}${randomUUID()}`),
    priorOutput = join(root, `${priorPrefix}${randomUUID()}`);
  await cp(builtOutput, stagedOutput, { recursive: true });
  let preservedPrior = false;
  try {
    if (await exists(output)) {
      await rename(output, priorOutput);
      preservedPrior = true;
    }
    await rename(stagedOutput, output);
    if (preservedPrior) await rm(priorOutput, { recursive: true, force: true });
  } catch (error) {
    if (!(await exists(output)) && preservedPrior) await rename(priorOutput, output);
    throw error;
  } finally {
    await rm(stagedOutput, { recursive: true, force: true });
  }
}

async function newestPath(paths: string[]) {
  const candidates = await Promise.all(paths.map(async path => ({ path, modified: (await stat(path)).mtimeMs })));
  candidates.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path));
  return candidates[0]!.path;
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false
  );
}
