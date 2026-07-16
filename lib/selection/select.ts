import type { PhotoRecord } from "@/lib/photos/types";

export type SelectionResult = { selected: PhotoRecord[]; rejected: PhotoRecord[]; heroId: string; reasons: Record<string, string> };
export function targetCount(inputCount: number, maxPhotos: number) {
  return Math.min(inputCount, Math.max(18, Math.min(maxPhotos, Math.round(inputCount * 0.12))));
}
export function selectPhotos(photos: PhotoRecord[], people: "include" | "exclude", maxPhotos: number): SelectionResult {
  const reasons: Record<string, string> = {};
  const seenClusters = new Set<string>();
  const eligible = photos
    .filter(photo => {
      if (photo.rejectionReasons.length) {
        reasons[photo.id] = photo.rejectionReasons.join("; ");
        return false;
      }
      if (people === "exclude" && photo.semantic?.containsPeople) {
        photo.rejectionReasons.push("Visible people excluded by privacy mode");
        reasons[photo.id] = photo.rejectionReasons[0]!;
        return false;
      }
      return true;
    })
    .sort((a, b) => score(b, people) - score(a, people));
  const selected: PhotoRecord[] = [];
  for (const photo of eligible) {
    if (selected.length >= targetCount(photos.length, maxPhotos)) break;
    if (photo.similarityCluster && seenClusters.has(photo.similarityCluster)) {
      reasons[photo.id] = "Near-duplicate composition";
      continue;
    }
    selected.push(photo);
    if (photo.similarityCluster) seenClusters.add(photo.similarityCluster);
    reasons[photo.id] = `Selected: weighted score ${score(photo, people).toFixed(1)} and adds chronological or visual coverage`;
  }
  selected.sort((a, b) => (a.captureTime ?? "").localeCompare(b.captureTime ?? ""));
  const rejected = photos.filter(photo => !selected.includes(photo));
  for (const photo of rejected) reasons[photo.id] ??= "Not selected within the editorial photo budget";
  const hero = [...selected].sort((a, b) => score(b, people) - score(a, people))[0];
  if (!hero) throw new Error("No publishable photos remain after quality and people filters");
  return { selected, rejected, heroId: hero.id, reasons };
}
function score(photo: PhotoRecord, people: "include" | "exclude") {
  const semantic = photo.semantic;
  if (!semantic) return photo.technical.overall;
  const finalValue = people === "include" ? Math.max(semantic.landmarkValue, semantic.emotionalValue) : semantic.landmarkValue;
  return (
    photo.technical.overall * 0.3 +
    semantic.aestheticScore * 0.3 +
    semantic.storyScore * 0.2 +
    semantic.uniquenessScore * 0.1 +
    finalValue * 0.1
  );
}
