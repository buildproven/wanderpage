import { hammingDistance } from "./scoring";
import type { PhotoRecord } from "./types";

export function groupDuplicates(photos: PhotoRecord[]): PhotoRecord[] {
  const hashes = new Map<string, string>();
  for (const photo of photos) {
    const original = hashes.get(photo.hash);
    if (original) {
      photo.duplicateOf = original;
      photo.rejectionReasons.push("Exact duplicate");
    } else hashes.set(photo.hash, photo.id);
  }
  let cluster = 0;
  for (let i = 0; i < photos.length; i++) {
    const current = photos[i]!;
    if (current.duplicateOf) continue;
    for (let j = i + 1; j < photos.length; j++) {
      const candidate = photos[j]!;
      if (candidate.duplicateOf) continue;
      if (hammingDistance(current.perceptualHash, candidate.perceptualHash) <= 7) {
        const id = current.similarityCluster ?? `cluster-${++cluster}`;
        current.similarityCluster = id;
        candidate.similarityCluster = id;
      }
    }
  }
  return photos;
}
