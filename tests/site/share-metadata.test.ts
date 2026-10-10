import { describe, expect, it } from "vitest";
import rawManifest from "@/data/trip.demo.json";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { storyShareMetadata } from "@/lib/share-metadata";

// @verifies DES-SITE-STORY, ARCH-SITE, REQ-UI-05, SN-08
describe("shared-link preview", () => {
  const trip = TripManifestSchema.parse(rawManifest);

  it("carries the title and description, and no image, when the site address is unknown", () => {
    const meta = storyShareMetadata(trip, undefined);
    expect(meta.openGraph).toMatchObject({ title: trip.title, description: trip.subtitle });
    expect(meta.openGraph).not.toHaveProperty("images");
    expect(meta.twitter).toMatchObject({ card: "summary" });
    expect(meta.metadataBase).toBeUndefined();
  });

  it("adds the hero photo as a large preview image once the site address is known", () => {
    const meta = storyShareMetadata(trip, "https://trips.example.com"),
      hero = trip.photos.find(photo => photo.id === trip.heroPhotoId)!;
    expect(String(meta.metadataBase)).toBe("https://trips.example.com/");
    expect(meta.openGraph).toMatchObject({ images: [{ url: hero.srcLarge, alt: hero.alt }] });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("rejects a site address that is not http or https", () => {
    expect(() => storyShareMetadata(trip, "ftp://example.com")).toThrow(/https:\/\//);
  });
});
