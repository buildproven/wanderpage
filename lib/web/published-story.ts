import { TripManifestSchema } from "@/lib/schemas/trip";
import { NeonStoryRepository } from "@/lib/web/neon-repository";

export async function loadHostedPublishedStory(slug: string) {
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined;
  const story = await NeonStoryRepository.fromEnvironment().findPublishedStoryBySlug(slug);
  return story?.manifest ? TripManifestSchema.parse(story.manifest) : undefined;
}
