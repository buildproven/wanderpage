import type { PhotoRecord } from "@/lib/photos/types";

export type DestinationEvidence = {
  id: string;
  name: string;
  confidence: number;
  lat: number;
  lon: number;
  photoIds: string[];
  evidence: string[];
};
const distanceKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const p = Math.PI / 180,
    dLat = (b.lat - a.lat) * p,
    dLon = (b.lon - a.lon) * p,
    s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
};

export async function inferDestinations(photos: PhotoRecord[], userAgent: string): Promise<DestinationEvidence[]> {
  const located = photos.filter((photo): photo is PhotoRecord & { gps: { lat: number; lon: number } } => photo.gps !== undefined);
  const clusters: Array<typeof located> = [];
  for (const photo of located) {
    const cluster = clusters.find(items => distanceKm(items[0]!.gps, photo.gps) < 25);
    if (cluster) cluster.push(photo);
    else clusters.push([photo]);
  }
  return Promise.all(
    clusters.map(async (items, index) => {
      const lat = items.reduce((sum, p) => sum + p.gps.lat, 0) / items.length,
        lon = items.reduce((sum, p) => sum + p.gps.lon, 0) / items.length;
      const entity = await nearestEntity(lat, lon, userAgent).catch(() => undefined);
      const visual = items.flatMap(photo => photo.semantic?.possibleLocations ?? []).sort((a, b) => b.confidence - a.confidence)[0];
      const name = entity?.title ?? (visual && visual.confidence >= 0.55 ? visual.label : `Region ${index + 1}`);
      const confidence = entity?.title?.length ? Math.min(0.98, 0.82 + items.length * 0.02) : (visual?.confidence ?? 0.5);
      return {
        id: `destination-${index + 1}`,
        name,
        confidence,
        lat,
        lon,
        photoIds: items.map(p => p.id),
        evidence: [
          `${items.length} photo(s) with nearby GPS metadata`,
          ...(entity ? [`Nearby Wikidata/Wikipedia entity: ${entity.title}`] : []),
          ...(visual ? [`Visible clue: ${visual.evidence}`] : []),
        ],
      };
    })
  );
}
async function nearestEntity(lat: number, lon: number, userAgent: string) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    generator: "geosearch",
    ggsprimary: "all",
    ggsnamespace: "0",
    ggsradius: "10000",
    ggscoord: `${lat}|${lon}`,
    prop: "coordinates",
    format: "json",
    origin: "*",
    ggslimit: "5",
  }).toString();
  const response = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw new Error(`Wikipedia geosearch ${response.status}`);
  const json = (await response.json()) as { query?: { pages?: Record<string, { title: string }> } };
  return Object.values(json.query?.pages ?? {})[0];
}
export function roundedCoordinate(value: number, privacy: "approximate" | "exact") {
  const precision = privacy === "exact" ? 2 : 1;
  return Number(value.toFixed(precision));
}
