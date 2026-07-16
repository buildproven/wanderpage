import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TripManifest } from "@/lib/schemas/trip";

export function tripSlug(title: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/, "");
  return slug || "untitled-trip";
}

export async function availableTripSlug(directory: string, manifest: TripManifest) {
  const base = tripSlug(manifest.title),
    year = `${manifest.dateRange?.start ?? ""} ${manifest.dateRange?.end ?? ""}`.match(/\b(?:19|20)\d{2}\b/)?.[0],
    dated = year ? `${base}-${year}` : undefined,
    candidates = [base, ...(dated && dated !== base ? [dated] : [])];
  for (let index = 2; index < 100; index++) candidates.push(`${base}-${index}`);
  for (const candidate of candidates) {
    const existing = await readFile(join(directory, `${candidate}.json`), "utf8")
      .then(value => JSON.parse(value) as Partial<TripManifest>)
      .catch(() => undefined);
    if (!existing || sameTrip(existing, manifest)) return candidate;
  }
  throw new Error("Could not allocate a unique page name for this trip.");
}

function sameTrip(existing: Partial<TripManifest>, manifest: TripManifest) {
  const existingPhotoIds = existing.photos?.map(photo => photo.id).sort(),
    manifestPhotoIds = manifest.photos.map(photo => photo.id).sort();
  return (
    existing.title === manifest.title &&
    existing.dateRange?.start === manifest.dateRange?.start &&
    existing.dateRange?.end === manifest.dateRange?.end &&
    existingPhotoIds?.length === manifestPhotoIds.length &&
    existingPhotoIds.every((id, index) => id === manifestPhotoIds[index])
  );
}
