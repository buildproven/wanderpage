import { cp, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.env.WANDERPAGE_WORKSPACE ?? process.cwd()),
  buildRoot = await mkdtemp(join(tmpdir(), "wanderpage-static-")),
  output = join(root, "out"),
  stagedOutput = join(root, `.out-next-${randomUUID()}`),
  priorOutput = join(root, `.out-prior-${randomUUID()}`);

try {
  for (const directory of ["app", "components", "lib", "public", "data"])
    await cp(join(root, directory), join(buildRoot, directory), { recursive: true });
  for (const serverOnly of ["app/.well-known", "app/api", "app/create", "app/stories", "app/s"])
    await rm(join(buildRoot, serverOnly), { recursive: true, force: true });
  await rm(join(buildRoot, "lib/web"), { recursive: true, force: true });
  await cp(join(root, "assets/static-trip-page.tsx"), join(buildRoot, "app/trips/[slug]/page.tsx"));
  for (const file of ["next-env.d.ts", "package.json", "postcss.config.mjs", "tsconfig.json"])
    await cp(join(root, file), join(buildRoot, file));
  await symlink(join(root, "node_modules"), join(buildRoot, "node_modules"), "dir");
  await writeFile(
    join(buildRoot, "next.config.mjs"),
    "export default { output: 'export', images: { unoptimized: true }, poweredByHeader: false };\n"
  );
  await run("pnpm", ["exec", "next", "build", "--webpack", buildRoot], buildRoot);
  await cp(join(buildRoot, "out"), stagedOutput, { recursive: true });
  let preservedPrior = false;
  try {
    await rename(output, priorOutput);
    preservedPrior = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    await rename(stagedOutput, output);
  } catch (error) {
    if (preservedPrior) await rename(priorOutput, output);
    throw error;
  }
  if (preservedPrior) await rm(priorOutput, { recursive: true, force: true });
  console.log(`Static rollback artifact: ${output}`);
} finally {
  await rm(stagedOutput, { recursive: true, force: true });
  await rm(buildRoot, { recursive: true, force: true });
}

function run(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", WANDERPAGE_WORKSPACE: cwd },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}`))));
  });
}
import { spawn } from "node:child_process";
