import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Story from "@/components/Story";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { listTrips } from "@/lib/trips/publish";
import { NeonStoryRepository } from "@/lib/web/neon-repository";

const root = process.env.WANDERPAGE_WORKSPACE ?? process.cwd(),
  directory = join(root, "data/trips");

export const dynamic = "force-dynamic";
export async function generateStaticParams() {
  const trips = await listTrips(root),
    published = trips.filter(trip => trip.manifest.published).map(trip => ({ slug: trip.slug }));
  return published.length ? published : [{ slug: "placeholder" }];
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params,
    trip = await loadTrip(slug);
  return trip ? { title: `${trip.title} — Wanderpage`, description: trip.subtitle } : {};
}
export default async function TripPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params,
    trip = await loadTrip(slug);
  if (!trip) notFound();
  return <Story trip={trip} />;
}

async function loadTrip(slug: string) {
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined;
  if (process.env.DATABASE_URL) {
    const story = await NeonStoryRepository.fromEnvironment().findPublishedStoryBySlug(slug);
    return story?.manifest ? TripManifestSchema.parse(story.manifest) : undefined;
  }
  return readFile(join(directory, `${slug}.json`), "utf8")
    .then(value => TripManifestSchema.parse(JSON.parse(value)))
    .catch(() => undefined);
}
