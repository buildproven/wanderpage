import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TripManifestSchema } from "@/lib/schemas/trip";

export function tripAssetsDirectory(root: string, slug: string) {
  return join(root, ".trip-assets", slug);
}

export async function syncPublishedAssets(root: string) {
  const generated = join(root, "public", "trip", "generated"),
    trips = await publishedTrips(root);
  await rm(generated, { recursive: true, force: true });
  await mkdir(generated, { recursive: true });
  for (const { slug } of trips) {
    const source = tripAssetsDirectory(root, slug),
      target = join(generated, slug);
    try {
      await readdir(source);
    } catch {
      throw new Error(`Published trip ${slug} is missing its private image assets.`);
    }
    await cp(source, target, { recursive: true });
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
