import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";

export async function listTrips(root: string) {
  const directory = join(root, "data/trips"),
    files = await readdir(directory)
      .then(entries => entries.filter(entry => entry.endsWith(".json")).sort())
      .catch(() => []);
  const trips: Array<{ slug: string; manifest: TripManifest }> = [];
  for (const file of files) {
    const slug = file.slice(0, -5),
      manifest = await readManifest(directory, slug);
    if (manifest) trips.push({ slug, manifest });
  }
  return trips;
}

export async function setTripPublished(root: string, slug: string, published: boolean) {
  const directory = join(root, "data/trips"),
    manifest = await readManifest(directory, slug);
  if (!manifest) throw new Error(`No trip found at data/trips/${slug}.json`);
  manifest.published = published;
  await writeFile(join(directory, `${slug}.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function readManifest(directory: string, slug: string) {
  return readFile(join(directory, `${slug}.json`), "utf8")
    .then(value => TripManifestSchema.parse(JSON.parse(value)))
    .catch(() => undefined);
}
