import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { replaceStaticOutput } from "@/lib/static-output";

const root = await realpath(resolve(process.env.WANDERPAGE_WORKSPACE ?? process.cwd())),
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), "wanderpage-static-"))),
  output = join(root, "out");

try {
  for (const directory of ["app", "components", "lib", "public", "data"])
    await cp(join(root, directory), join(buildRoot, directory), { recursive: true });
  for (const serverOnly of ["app/.well-known", "app/api", "app/create", "app/stories", "app/s"])
    await rm(join(buildRoot, serverOnly), { recursive: true, force: true });
  const layoutPath = join(buildRoot, "app/layout.tsx"),
    layout = await readFile(layoutPath, "utf8");
  await writeFile(layoutPath, layout.replace('export const dynamic = "force-dynamic";\n', ""));
  await rm(join(buildRoot, "lib/web"), { recursive: true, force: true });
  await cp(join(root, "assets/static-trip-page.tsx"), join(buildRoot, "app/trips/[slug]/page.tsx"));
  for (const file of ["next-env.d.ts", "package.json", "postcss.config.mjs", "tsconfig.json"])
    await cp(join(root, file), join(buildRoot, file));
  await symlink(relative(buildRoot, join(root, "node_modules")), join(buildRoot, "node_modules"), "dir");
  await writeFile(
    join(buildRoot, "next.config.mjs"),
    "export default { output: 'export', images: { unoptimized: true }, poweredByHeader: false };\n"
  );
  await run(join(root, "node_modules/.bin/next"), ["build", "--webpack", buildRoot], buildRoot);
  await replaceStaticOutput(root, join(buildRoot, "out"));
  console.log(`Static rollback artifact: ${output}`);
} finally {
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
