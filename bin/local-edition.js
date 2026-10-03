// @design DES-CLI-LAUNCH
// What a person who only wants to make trip pages needs. The published package also contains the developer toolchain and the hosted
// service; installing those made a first run download over a thousand packages (869 MB) before anything appeared on screen.

const keepForBuild = new Set(["typescript", "@types/node", "@types/react", "@types/react-dom"]);
const hostedOnly = new Set(["workflow", "@workflow/next", "@neondatabase/serverless", "@vercel/blob"]);
const keepScripts = [
  "studio",
  "private",
  "trip",
  "trip:demo",
  "trip:list",
  "trip:publish",
  "trip:unpublish",
  "wanderpage",
  "static:export",
  "preview:static",
  "privacy",
  "deploy",
];

/** Files and folders that are never copied into a user's project. */
export const notCopied = new Set([
  "node_modules",
  ".next",
  "out",
  ".git",
  ".trip-cache",
  ".trip-output",
  ".vercel",
  ".github",
  ".husky",
  "pnpm-workspace.yaml",
  "db",
  "workflows",
  "proxy.ts",
  "next.config.ts",
]);

/** The package.json for a user's project: runtime dependencies only, and only the scripts that make sense without the dev toolchain. */
export function localEdition(pkg) {
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([name]) => !hostedOnly.has(name))),
    devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies ?? {}).filter(([name]) => keepForBuild.has(name)));
  const scripts = Object.fromEntries(keepScripts.filter(name => pkg.scripts?.[name]).map(name => [name, pkg.scripts[name]]));
  const { name, version, description, license, type, bin, engines } = pkg;
  return { name, version, private: true, description, license, type, bin, engines, scripts, dependencies, devDependencies };
}

/** A friendly message when this Node.js is too old to run Wanderpage, or undefined when it is fine. */
export function nodeVersionProblem(version) {
  if (Number(version.split(".")[0]) >= 24) return undefined;
  return `Wanderpage needs Node.js 24 or newer, and this is Node.js ${version}.\nInstall the current LTS from https://nodejs.org, then run the same command again.`;
}
