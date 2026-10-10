// @design DES-SITE-STORY
import type { Metadata } from "next";
import type { TripManifest } from "@/lib/schemas/trip";

/**
 * Link-preview tags for a published story. The preview image needs an absolute
 * URL, so it is emitted only when the owner says where the site will live
 * (`WANDERPAGE_SITE_URL`); without it the title and description still travel.
 * Only fields already public in the manifest are used, so this cannot widen
 * what a story discloses.
 */
export function storyShareMetadata(trip: TripManifest, siteUrl = process.env.WANDERPAGE_SITE_URL): Metadata {
  const base = parseSiteUrl(siteUrl),
    hero = trip.photos.find(photo => photo.id === trip.heroPhotoId),
    title = `${trip.title} — Wanderpage`,
    images = base && hero ? [{ url: hero.srcLarge, width: hero.width, height: hero.height, alt: hero.alt }] : undefined;
  return {
    title,
    description: trip.subtitle,
    ...(base ? { metadataBase: base } : {}),
    openGraph: { type: "article", title: trip.title, description: trip.subtitle, siteName: "Wanderpage", ...(images ? { images } : {}) },
    twitter: {
      card: images ? "summary_large_image" : "summary",
      title: trip.title,
      description: trip.subtitle,
      ...(images ? { images } : {}),
    },
  };
}

function parseSiteUrl(value: string | undefined) {
  const text = value?.trim();
  if (!text) return undefined;
  const url = new URL(text.endsWith("/") ? text : `${text}/`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("WANDERPAGE_SITE_URL must start with https:// or http://");
  return url;
}
