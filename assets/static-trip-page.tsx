// @design DES-SITE-STORY
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Story from "@/components/Story";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { storyShareMetadata } from "@/lib/share-metadata";
import { listTrips } from "@/lib/trips/publish";

const root = process.env.WANDERPAGE_WORKSPACE ?? process.cwd();
export const dynamicParams = false;

export async function generateStaticParams() {
  const published = (await listTrips(root)).filter(trip => trip.manifest.published).map(trip => ({ slug: trip.slug }));
  return published.length ? published : [{ slug: "placeholder" }];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const trip = await loadTrip((await params).slug);
  return trip ? storyShareMetadata(trip) : {};
}

export default async function TripPage({ params }: { params: Promise<{ slug: string }> }) {
  const trip = await loadTrip((await params).slug);
  if (!trip) notFound();
  return <Story trip={trip} />;
}

async function loadTrip(slug: string) {
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined;
  return readFile(join(root, "data/trips", `${slug}.json`), "utf8")
    .then(value => TripManifestSchema.parse(JSON.parse(value)))
    .then(manifest => (manifest.published ? manifest : undefined))
    .catch(() => undefined);
}
