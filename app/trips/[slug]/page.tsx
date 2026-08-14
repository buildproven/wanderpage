import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Story from "@/components/Story";
import { loadHostedPublishedStory } from "@/lib/web/published-story";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params,
    trip = await loadHostedPublishedStory(slug);
  return trip ? { title: `${trip.title} — Wanderpage`, description: trip.subtitle } : {};
}
export default async function TripPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params,
    trip = await loadHostedPublishedStory(slug);
  if (!trip) notFound();
  return <Story trip={trip} />;
}
