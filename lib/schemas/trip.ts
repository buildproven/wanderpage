import { z } from "zod";

const dateRange = z.object({ start: z.string(), end: z.string() });
const coordinate = z.object({ lat: z.number(), lon: z.number() });

export const TripManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generatedAt: z.string(),
  title: z.string(),
  subtitle: z.string(),
  opening: z.string(),
  closing: z.string(),
  dateRange: dateRange.optional(),
  peopleMode: z.enum(["include", "exclude"]),
  theme: z.object({
    background: z.string(), foreground: z.string(), accent: z.string(), muted: z.string(),
  }),
  heroPhotoId: z.string(),
  stats: z.array(z.object({ label: z.string(), value: z.string() })),
  destinations: z.array(z.object({
    id: z.string(), name: z.string(), region: z.string().optional(), country: z.string().optional(),
    confidence: z.number().min(0).max(1), approximateCoordinate: coordinate.optional(),
    dateRange: dateRange.optional(), introduction: z.string(),
    facts: z.array(z.object({ text: z.string(), sourceId: z.string() })),
  })),
  route: z.array(z.object({ destinationId: z.string(), sequence: z.number().int(), lat: z.number(), lon: z.number() })),
  chapters: z.array(z.object({
    id: z.string(), title: z.string(), subtitle: z.string().optional(), destinationId: z.string().optional(),
    date: z.string().optional(), narrative: z.string(), photoIds: z.array(z.string()),
    layout: z.enum(["hero", "split", "filmstrip", "mosaic", "editorial"]),
  })),
  photos: z.array(z.object({
    id: z.string(), srcLarge: z.string(), srcMedium: z.string(), srcThumb: z.string(),
    width: z.number().positive(), height: z.number().positive(), blurDataURL: z.string().optional(),
    alt: z.string(), caption: z.string().optional(), captureTime: z.string().optional(), destinationId: z.string().optional(),
    containsPeople: z.boolean(), source: z.enum(["user", "wikimedia"]), creditId: z.string().optional(),
  })),
  sources: z.array(z.object({
    id: z.string(), title: z.string(), url: z.string().url(), provider: z.string(), author: z.string().optional(), license: z.string().optional(),
  })),
});

export type TripManifest = z.infer<typeof TripManifestSchema>;
