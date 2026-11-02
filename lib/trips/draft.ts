// @design DES-PUB-STORE
// Relative imports only: the MCP server runs this file through tsx, which does not apply tsconfig "@/" paths under node_modules.
import { TripManifestSchema, type TripManifest } from "../schemas/trip";

/**
 * The draft check every editor (Studio and MCP) applies before writing a draft: at least one photo, no duplicate photos, a hero that is
 * in the story (else the first photo), and chapters, routes, and destination links that point only at what remains.
 */
export function normalizeDraft(manifest: TripManifest) {
  if (!manifest.photos.length) throw new Error("Keep at least one selected photo in the story.");
  const photoIds = new Set(manifest.photos.map(photo => photo.id));
  if (photoIds.size !== manifest.photos.length) throw new Error("A story cannot contain the same photo more than once.");
  const heroPhotoId = photoIds.has(manifest.heroPhotoId) ? manifest.heroPhotoId : manifest.photos[0]!.id;
  const destinationIds = new Set(manifest.destinations.map(destination => destination.id));
  const chapters = manifest.chapters
    .map(chapter => ({
      ...chapter,
      destinationId: chapter.destinationId && destinationIds.has(chapter.destinationId) ? chapter.destinationId : undefined,
      photoIds: chapter.photoIds.filter(photoId => photoIds.has(photoId)),
    }))
    .filter(chapter => chapter.photoIds.length > 0);
  return TripManifestSchema.parse({
    ...manifest,
    heroPhotoId,
    photos: manifest.photos.map(photo =>
      photo.destinationId && !destinationIds.has(photo.destinationId) ? { ...photo, destinationId: undefined } : photo
    ),
    route: manifest.route.filter(point => destinationIds.has(point.destinationId)),
    stats: manifest.stats.map(stat => (stat.label === "Destinations" ? { ...stat, value: String(manifest.destinations.length) } : stat)),
    chapters,
  });
}
