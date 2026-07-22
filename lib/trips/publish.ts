import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";
import { removeTripAssets, syncPublishedAssets } from "@/lib/trips/assets";

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
  const manifest = await getTrip(root, slug);
  if (!manifest) throw new Error(`No trip found at data/trips/${slug}.json`);
  manifest.published = published;
  const saved = await writeTrip(root, slug, manifest);
  await syncPublishedAssets(root);
  return saved;
}

export async function getTrip(root: string, slug: string) {
  if (!validSlug(slug)) return undefined;
  return readManifest(join(root, "data/trips"), slug);
}

export async function writeTrip(root: string, slug: string, manifest: TripManifest) {
  if (!validSlug(slug)) throw new Error("Trip slug is invalid.");
  const parsed = TripManifestSchema.parse(manifest);
  await mkdir(join(root, "data/trips"), { recursive: true });
  await writeFile(join(root, "data/trips", `${slug}.json`), JSON.stringify(parsed, null, 2));
  return parsed;
}

export async function deleteTrip(root: string, slug: string) {
  if (!validSlug(slug)) throw new Error("Trip slug is invalid.");
  const manifest = await getTrip(root, slug);
  if (!manifest) throw new Error(`No trip found at data/trips/${slug}.json`);
  await unlink(join(root, "data/trips", `${slug}.json`));
  await syncPublishedAssets(root);
  await removeTripAssets(root, slug);
  return manifest;
}

async function readManifest(directory: string, slug: string) {
  return readFile(join(directory, `${slug}.json`), "utf8")
    .then(value => TripManifestSchema.parse(JSON.parse(value)))
    .catch(() => undefined);
}

function validSlug(slug: string) {
  return /^[a-z0-9-]+$/.test(slug);
}
