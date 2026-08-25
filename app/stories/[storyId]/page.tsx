import { notFound } from "next/navigation";
import DraftControls from "@/components/DraftControls";
import Story from "@/components/Story";
import { getStoryService } from "@/lib/web/runtime";
import { ownerSecret } from "@/lib/web/session";
import { StoryServiceError } from "@/lib/web/story-service";

export const dynamic = "force-dynamic";

export default async function PrivateStoryPage({ params }: { params: Promise<{ storyId: string }> }) {
  const { storyId } = await params,
    privateStory = await loadPrivateStory(storyId);
  if (!privateStory.story.manifest)
    return (
      <main className="product-page">
        <DraftControls
          key={`${privateStory.story.id}:${privateStory.story.version}`}
          story={privateStory.story}
          csrfToken={privateStory.session.csrfToken}
        />
      </main>
    );
  return (
    <>
      <DraftControls
        key={`${privateStory.story.id}:${privateStory.story.version}`}
        story={privateStory.story}
        csrfToken={privateStory.session.csrfToken}
      />
      <Story trip={privateStory.story.manifest} />
    </>
  );
}

async function loadPrivateStory(storyId: string) {
  const stories = getStoryService(),
    secret = await ownerSecret();
  if (!secret) notFound();
  try {
    const [story, session] = await Promise.all([stories.getOwnedStory(secret, storyId), stories.requireSession(secret)]);
    return { story, session };
  } catch (error) {
    if (error instanceof StoryServiceError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN" || error.code === "AUTH_REQUIRED"))
      notFound();
    throw error;
  }
}
