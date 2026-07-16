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
  rejectionReason: z.string().optional(),
});

export const ContactSheetAnalysisSchema = z.object({ photos: z.array(PhotoSemanticAnalysisSchema) });
export type PhotoSemanticAnalysis = z.infer<typeof PhotoSemanticAnalysisSchema>;
