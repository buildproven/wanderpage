// @design DES-PUB-EXPORT
import { randomUUID } from "node:crypto";
import { access, cp, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const priorPrefix = ".out-prior-";
const stagedPrefix = ".out-next-";

/** The shareable site: the folder inside `out/` that a user copies to a web host. */
export const shareableSiteFolder = "site";

/** Paths (relative to `out/`) that belong to Studio or the demo trip, so the shareable site omits them. */
const toolOnlyPaths = [
  "studio",
  "studio.html",
  "studio.txt",
  "demo",
  "demo.html",
  "demo.txt",
  "trip/demo",
  "_next/static/chunks/app/studio",
  "_next/static/chunks/app/demo",
];

/**
 * Copies the built export to `<output>/site`, leaving out Studio, the demo page and the demo-trip images.
 * Studio keeps loading from the rest of `output`; only the folder named here is meant for a web host.
 */
export async function writeShareableSite(output: string) {
  // cp refuses to copy a folder into itself, so the copy goes to a sibling first and is moved in whole.
  const copy = join(dirname(output), `${stagedPrefix}site-${randomUUID()}`);
  try {
    await cp(output, copy, {
      recursive: true,
      filter: source => {
        const path = relative(output, source).split(sep).join("/");
        return path !== shareableSiteFolder && !toolOnlyPaths.includes(path);
      },
    });
    await rm(join(output, shareableSiteFolder), { recursive: true, force: true });
    await rename(copy, join(output, shareableSiteFolder));
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

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
  await writeShareableSite(stagedOutput);
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
