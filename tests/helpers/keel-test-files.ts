// Keel's testFilesCommand (REQ-KEELCFG-1): runs each given test file with the runner that owns it, and fails
// when no given file is a test, so a passing run always means a test ran. Playwright specs under tests/e2e get
// the same build that `pnpm test` gives them; every other test file goes to vitest.
import { spawnSync } from "node:child_process";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type Step = { command: string; args: string[]; env?: Record<string, string> };

const testName = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const e2eDir = "tests/e2e/";
const tsx = ["node_modules/tsx/dist/cli.mjs"];

/** A path relative to `root` with `/` separators, as vitest.config.ts and playwright.config.ts match it. */
export function repoPath(file: string, root = process.cwd()) {
  const path = isAbsolute(file) ? relative(root, file) : normalize(file);
  return path.split(sep).join("/");
}

/** The commands that run `files`; throws when none of them is a test file either runner runs. */
export function planTestFiles(files: string[], root = process.cwd()): Step[] {
  const tests = files.map(file => repoPath(file, root)).filter(path => testName.test(path) && !path.startsWith("node_modules/"));
  const specs = tests.filter(path => path.startsWith(e2eDir)),
    unit = tests.filter(path => !path.startsWith(e2eDir));
  if (tests.length === 0) throw new Error(`No test file among the given files: ${files.join(" ") || "(none)"}`);
  const steps: Step[] = [];
  if (unit.length > 0) steps.push({ command: "pnpm", args: ["exec", "vitest", "run", ...unit] });
  if (specs.length > 0)
    steps.push(
      { command: "node", args: [...tsx, "scripts/trip.ts", "--demo"] },
      { command: "pnpm", args: ["exec", "next", "build", "--webpack"] },
      { command: "node", args: [...tsx, "scripts/static-export.ts"] },
      // CI=1 starts this checkout's own servers instead of reusing one another checkout left on the same port.
      { command: "pnpm", args: ["exec", "playwright", "test", ...specs], env: { CI: "1" } }
    );
  return steps;
}

function main(files: string[]) {
  let steps: Step[];
  try {
    steps = planTestFiles(files);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  for (const step of steps) {
    const result = spawnSync(step.command, step.args, { stdio: "inherit", env: { ...process.env, ...step.env } });
    if (result.error) {
      console.error(`${step.command} ${step.args.join(" ")}: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
