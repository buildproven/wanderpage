import { describe, expect, it } from "vitest";
import { applyLocationPrivacy } from "@/lib/web/processor";

describe("hosted manifest privacy", () => {
  it("removes location-bearing narrative and metadata in hidden mode", () => {
    const hidden = applyLocationPrivacy(manifest(), "hidden");
    expect(JSON.stringify(hidden)).not.toContain("Secret Cove");
    expect(hidden.destinations).toEqual([]);
    expect(hidden.route).toEqual([]);
    expect(hidden.sources).toEqual([]);
    expect(hidden.photos[0]).toMatchObject({ alt: "Selected travel photograph.", caption: undefined });
  });

  it("keeps only broad labels and no coordinates or enrichment sources in broad mode", () => {
    const broad = applyLocationPrivacy(manifest(), "broad");
    expect(broad.destinations[0]).toMatchObject({ name: "Oregon", approximateCoordinate: undefined });
    expect(broad.route).toEqual([]);
    expect(broad.sources).toEqual([]);
    expect(JSON.stringify(broad)).not.toContain("Secret Cove");
  });
});

function manifest() {
  return {
    schemaVersion: "1.0" as const,
    generatedAt: "2026-08-13T00:00:00.000Z",
    published: false,
    title: "Private story",
    subtitle: "Morning at Secret Cove",
    opening: "Secret Cove appeared below the trail.",
    closing: "The route ended at Secret Cove.",
    peopleMode: "exclude" as const,
    theme: { background: "#fff", foreground: "#111", accent: "#333", muted: "#666" },
    heroPhotoId: "photo-1",
    stats: [{ label: "Destinations", value: "1" }],
    destinations: [
      {
        id: "place-1",
        name: "Secret Cove, Oregon",
        confidence: 0.9,
        approximateCoordinate: { lat: 45.1, lon: -123.1 },
        introduction: "Secret Cove detail",
        facts: [{ text: "Secret Cove fact", sourceId: "source-1" }],
      },
    ],
    route: [{ destinationId: "place-1", sequence: 1, lat: 45.1, lon: -123.1 }],
    chapters: [
      {
        id: "chapter-1",
        title: "Secret Cove",
        destinationId: "place-1",
        narrative: "Secret Cove chapter.",
        photoIds: ["photo-1"],
        layout: "hero" as const,
      },
    ],
    photos: [
      {
        id: "photo-1",
        srcLarge: "/large.webp",
        srcMedium: "/medium.webp",
        srcThumb: "/thumb.webp",
        width: 100,
        height: 100,
        alt: "Secret Cove cliffs",
        caption: "Secret Cove",
        destinationId: "place-1",
        containsPeople: false,
        source: "user" as const,
      },
    ],
    sources: [{ id: "source-1", title: "Secret Cove", url: "https://example.com", provider: "example" }],
  };
}
