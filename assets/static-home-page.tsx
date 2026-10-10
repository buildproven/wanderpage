// @design DES-SITE-HOME
import type { Metadata } from "next";
import Landing from "@/components/Landing";
import Story from "@/components/Story";
import StoryIndex from "@/components/StoryIndex";
import { storyShareMetadata } from "@/lib/share-metadata";
import { listTrips } from "@/lib/trips/publish";

const root = process.env.WANDERPAGE_WORKSPACE ?? process.cwd();

const published = async () => (await listTrips(root)).filter(trip => trip.manifest.published);

export async function generateMetadata(): Promise<Metadata> {
  const stories = await published();
  if (stories.length === 1) return storyShareMetadata(stories[0]!.manifest);
  return stories.length ? { title: "Trip stories — Wanderpage" } : {};
}

export default async function Home() {
  const stories = await published();
  if (stories.length === 0) return <Landing />;
  if (stories.length === 1) return <Story trip={stories[0]!.manifest} />;
  return (
    <StoryIndex
      stories={stories.map(({ slug, manifest }) => ({
        slug,
        title: manifest.title,
        subtitle: manifest.subtitle,
        image: manifest.photos.find(photo => photo.id === manifest.heroPhotoId)?.srcMedium,
      }))}
    />
  );
}
