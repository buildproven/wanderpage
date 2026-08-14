import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { applyLocationPrivacy, validateHostedDerivative, validateHostedStoryOutput } from "@/lib/web/processor";

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

  it("rejects hosted manifests that reference local or unowned media", async () => {
    const unsafe = manifest();
    unsafe.opening = "Imported from /Users/example/Pictures/private";
    await expect(validateHostedStoryOutput("story-1", "run-1", unsafe, "approximate")).rejects.toThrow(/PRIVACY_FAILED.*Users/);
  });

  it("rejects policy-invalid raw coordinates and configured secrets", async () => {
    const unsafe = manifest(),
      sensitiveName = ["WANDERPAGE", "TEST", "TOKEN"].join("_"),
      previous = process.env[sensitiveName];
    process.env[sensitiveName] = "hosted-test-credential-value";
    unsafe.opening = `private token: ${process.env[sensitiveName]}`;
    try {
      await expect(validateHostedStoryOutput("story-1", "run-1", unsafe, "hidden")).rejects.toThrow(
        /PRIVACY_FAILED.*configured secret WANDERPAGE_TEST_TOKEN.*hidden manifests must not contain coordinates/
      );
    } finally {
      if (previous === undefined) delete process.env[sensitiveName];
      else process.env[sensitiveName] = previous;
    }
  });

  it("rejects derivative bytes with embedded camera metadata", async () => {
    const fixture = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .withMetadata({ orientation: 1 })
      .jpeg()
      .toBuffer();
    await expect(validateHostedDerivative(fixture)).resolves.toEqual(
      expect.arrayContaining(["derivative is not WebP", "derivative contains embedded metadata"])
    );
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
