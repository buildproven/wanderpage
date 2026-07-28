import { z } from "zod";

export const photoCategorySchema = z.enum([
  "landscape",
  "architecture",
  "food",
  "activity",
  "wildlife",
  "people",
  "transport",
  "detail",
  "night",
  "other",
]);

export const PhotoSemanticAnalysisSchema = z.object({
  photoId: z.string(),
  containsPeople: z.boolean(),
  peopleProminence: z.enum(["none", "background", "prominent"]),
  aestheticScore: z.number().min(0).max(100),
  storyScore: z.number().min(0).max(100),
  landmarkValue: z.number().min(0).max(100),
  emotionalValue: z.number().min(0).max(100),
  uniquenessScore: z.number().min(0).max(100),
  categories: z.array(photoCategorySchema),
  possibleLocations: z.array(z.object({ label: z.string(), confidence: z.number().min(0).max(1), evidence: z.string() })),
  captionSeed: z.string(),
});

export const ContactSheetAnalysisSchema = z.object({ photos: z.array(PhotoSemanticAnalysisSchema) });
export type PhotoSemanticAnalysis = z.infer<typeof PhotoSemanticAnalysisSchema>;

export function requireCompleteContactSheetAnalysis(analysis: PhotoSemanticAnalysis[], photoIds: string[]) {
  const expected = new Set(photoIds),
    actual = new Set(analysis.map(item => item.photoId));
  if (expected.size !== photoIds.length) throw new Error("Contact sheet contains duplicate photo IDs.");
  const missing = photoIds.filter(photoId => !actual.has(photoId)),
    unexpected = analysis.map(item => item.photoId).filter(photoId => !expected.has(photoId)),
    duplicate = analysis.find((item, index) => analysis.findIndex(candidate => candidate.photoId === item.photoId) !== index)?.photoId;
  if (missing.length || unexpected.length || duplicate) {
    const details = [
      missing.length ? `missing: ${missing.join(", ")}` : "",
      unexpected.length ? `unexpected: ${unexpected.join(", ")}` : "",
      duplicate ? `duplicate: ${duplicate}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`Contact-sheet analysis must return one result for every photo (${details}).`);
  }
  return analysis;
}
