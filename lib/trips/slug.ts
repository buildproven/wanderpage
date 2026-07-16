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
    dated = manifest.dateRange?.start ? `${base}-${manifest.dateRange.start.slice(0, 4)}` : undefined,
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
  return (
    existing.title === manifest.title &&
    existing.dateRange?.start === manifest.dateRange?.start &&
    existing.dateRange?.end === manifest.dateRange?.end
  );
}
