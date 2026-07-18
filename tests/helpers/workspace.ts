import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const execute = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function createTempWorkspace(label: string) {
  return mkdtemp(join(repoRoot, `.wanderpage-test-${label}-`));
}

export async function removeTempWorkspace(path: string) {
  const systemTemp = await realpath(tmpdir()),
    resolved = await realpath(path).catch(() => resolve(path)),
    parent = dirname(resolved);
  const safeSystemTemp = parent === systemTemp && basename(resolved).startsWith("wanderpage-");
  const safeRepositoryTemp = parent === repoRoot && basename(resolved).startsWith(".wanderpage-test-");
  if (!safeSystemTemp && !safeRepositoryTemp) throw new Error(`Refusing to remove unsafe test path: ${resolved}`);
  await rm(resolved, { recursive: true, force: true, maxRetries: 2 });
}

export async function createPhotoFolder(
  workspace: string,
  { count = 8, heic = false, gps = true }: { count?: number; heic?: boolean; gps?: boolean } = {}
) {
  const input = join(workspace, "input-photos"),
    nested = join(input, "day-two");
  await mkdir(nested, { recursive: true });
  const sources = ["coast-hero.png", "headland.png", "tidepool.png", "cabin.png"];
  const paths: string[] = [];
  for (let index = 0; index < count; index++) {
    const source = join(repoRoot, "assets/demo", sources[index % sources.length]!);
    const target = join(index % 2 ? nested : input, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
    const coordinate =
      index < Math.ceil(count / 2)
        ? { lat: 45.88 + index * 0.002, lon: -123.96 - index * 0.002 }
        : { lat: 44.63 + index * 0.002, lon: -124.05 - index * 0.002 };
    await sharp(source)
      .rotate(index % 4 === 3 ? 180 : 0)
      .modulate({ brightness: 1 + (index % 3) * 0.025, saturation: 1 + (index % 2) * 0.04 })
      .withExif({
        IFD0: { Model: "Wanderpage Integration Camera" },
        IFD2: { DateTimeOriginal: `2026:09:${String(index + 4).padStart(2, "0")} 12:00:00` },
        ...(gps ? { IFD3: gpsExif(coordinate.lat, coordinate.lon) } : {}),
      })
      .jpeg({ quality: 88 })
      .toFile(target);
    paths.push(target);
  }
  await cp(paths[0]!, join(nested, "frame-01-exact-duplicate.jpg"));
  await sharp(paths[1]!).webp({ quality: 84 }).toFile(join(nested, "frame-webp.webp"));
  if (heic && process.platform === "darwin") {
    const heicPath = join(nested, "frame-heic.heic");
    await execute("sips", ["-s", "format", "heic", paths[2]!, "--out", heicPath]);
  }
  return input;
}

export async function copySiteScaffold(workspace: string) {
  for (const directory of ["app", "components", "lib/schemas", "lib/trips"])
    await cp(join(repoRoot, directory), join(workspace, directory), { recursive: true });
  await cp(join(repoRoot, "lib/studio/types.ts"), join(workspace, "lib/studio/types.ts"));
  await cp(join(repoRoot, "public/trip/demo"), join(workspace, "public/trip/demo"), { recursive: true });
  await cp(join(repoRoot, "data/trip.demo.json"), join(workspace, "data/trip.demo.json"));
  for (const file of ["next.config.ts", "next-env.d.ts", "package.json", "tsconfig.json"])
    await cp(join(repoRoot, file), join(workspace, file));
}

function gpsExif(lat: number, lon: number) {
  return {
    GPSLatitudeRef: lat >= 0 ? "N" : "S",
    GPSLatitude: degrees(Math.abs(lat)),
    GPSLongitudeRef: lon >= 0 ? "E" : "W",
    GPSLongitude: degrees(Math.abs(lon)),
  };
}

function degrees(value: number) {
  const whole = Math.floor(value),
    minutes = (value - whole) * 60,
    minuteWhole = Math.floor(minutes),
    seconds = Math.round((minutes - minuteWhole) * 6000);
  return `${whole}/1 ${minuteWhole}/1 ${seconds}/100`;
}
