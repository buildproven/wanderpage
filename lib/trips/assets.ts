import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { TripManifestSchema } from "@/lib/schemas/trip";

export function tripAssetsDirectory(root: string, slug: string) {
  return join(root, ".trip-assets", slug);
}

export async function syncPublishedAssets(root: string) {
  const generated = join(root, "public", "trip", "generated"),
    next = join(root, "public", "trip", `.generated-next-${randomUUID()}`),
    backup = join(root, "public", "trip", `.generated-backup-${randomUUID()}`),
    trips = await publishedTrips(root);
  await mkdir(next, { recursive: true });
  try {
    for (const { slug } of trips) {
      const source = tripAssetsDirectory(root, slug),
        target = join(next, slug);
      try {
        await readdir(source);
      } catch {
        throw new Error(`Published trip ${slug} is missing its private image assets.`);
      }
      await cp(source, target, { recursive: true });
    }
    await rename(generated, backup).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    try {
      await rename(next, generated);
    } catch (error) {
      await rename(backup, generated).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(next, { recursive: true, force: true });
    throw error;
  }
}

export async function removeTripAssets(root: string, slug: string) {
  await rm(tripAssetsDirectory(root, slug), { recursive: true, force: true });
}

async function publishedTrips(root: string) {
  const directory = join(root, "data", "trips");
  const entries = await readdir(directory).catch(() => [] as string[]);
  const trips = await Promise.all(
    entries
      .filter(entry => entry.endsWith(".json"))
      .map(async entry => {
        const manifest = await readFile(join(directory, entry), "utf8")
          .then(value => TripManifestSchema.parse(JSON.parse(value)))
          .catch(() => undefined);
        return manifest?.published ? { slug: entry.slice(0, -5) } : undefined;
      })
  );
  return trips.filter((trip): trip is { slug: string } => Boolean(trip));
}
