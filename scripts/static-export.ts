import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.env.WANDERPAGE_WORKSPACE ?? process.cwd()),
  buildRoot = await mkdtemp(join(tmpdir(), "wanderpage-static-"));

try {
  for (const directory of ["app", "components", "lib", "public", "data"])
    await cp(join(root, directory), join(buildRoot, directory), { recursive: true });
  for (const serverOnly of ["app/.well-known", "app/api", "app/create", "app/stories", "app/s"])
    await rm(join(buildRoot, serverOnly), { recursive: true, force: true });
  await rm(join(buildRoot, "lib/web"), { recursive: true, force: true });
  await writeFile(
    join(buildRoot, "app/trips/[slug]/page.tsx"),
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Story from "@/components/Story";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { listTrips } from "@/lib/trips/publish";

const root = process.env.WANDERPAGE_WORKSPACE ?? process.cwd();
export const dynamicParams = false;
export async function generateStaticParams() {
  const published = (await listTrips(root)).filter(trip => trip.manifest.published).map(trip => ({ slug: trip.slug }));
  return published.length ? published : [{ slug: "placeholder" }];
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const trip = await loadTrip((await params).slug);
  return trip ? { title: \`${"${trip.title}"} — Wanderpage\`, description: trip.subtitle } : {};
}
export default async function TripPage({ params }: { params: Promise<{ slug: string }> }) {
  const trip = await loadTrip((await params).slug);
  if (!trip) notFound();
  return <Story trip={trip} />;
}
async function loadTrip(slug: string) {
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined;
  return readFile(join(root, "data/trips", \`${"${slug}"}.json\`), "utf8")
    .then(value => TripManifestSchema.parse(JSON.parse(value)))
    .catch(() => undefined);
}
`
  );
  for (const file of ["next-env.d.ts", "package.json", "postcss.config.mjs", "tsconfig.json"])
    await cp(join(root, file), join(buildRoot, file));
  await symlink(join(root, "node_modules"), join(buildRoot, "node_modules"), "dir");
  await writeFile(
    join(buildRoot, "next.config.mjs"),
    "export default { output: 'export', images: { unoptimized: true }, poweredByHeader: false };\n"
  );
  await run("pnpm", ["exec", "next", "build", "--webpack", buildRoot], buildRoot);
  await rm(join(root, "out"), { recursive: true, force: true });
  await mkdir(join(root, "out"), { recursive: true });
  await cp(join(buildRoot, "out"), join(root, "out"), { recursive: true });
  console.log(`Static rollback artifact: ${join(root, "out")}`);
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
