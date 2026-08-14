import { get } from "@vercel/blob";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { ownerSecret } from "@/lib/web/session";
import { getStoryService } from "@/lib/web/runtime";

export async function GET(_request: Request, context: { params: Promise<{ storyId: string; filename: string }> }) {
  const { storyId, filename } = await context.params,
    safeName = filename.replace(/[^a-zA-Z0-9.-]/g, "");
  if (!safeName || safeName !== filename) return new Response("Not found", { status: 404 });
  try {
    const stories = getStoryService(),
      secret = await ownerSecret(),
      hasOwnerCredential = Boolean(secret);
    let story = secret ? await stories.getOwnedStory(secret, storyId).catch(() => undefined) : undefined;
    if (!story) {
      // A public story's derivatives remain private in Blob; this route is the only public reader.
      story = await NeonStoryRepository.fromEnvironment().findStory(storyId);
      if (!story || story.status !== "published") return new Response("Not found", { status: 404 });
    }
    const requestedPath = `/api/media/${storyId}/${safeName}`;
    if (!story.manifest || !story.manifest.photos.some(photo => [photo.srcLarge, photo.srcMedium, photo.srcThumb].includes(requestedPath)))
      return new Response("Not found", { status: 404 });
    const [revision, runId, ...nameParts] = safeName.split("--"),
      name = nameParts.join("--");
    if (!revision || !runId || !name) return new Response("Not found", { status: 404 });
    const object = await get(`derivatives/${storyId}/${revision}/${runId}/${name}`, { access: "private" });
    if (!object || object.statusCode !== 200) return new Response("Not found", { status: 404 });
    return new Response(object.stream, {
      headers: {
        "Content-Type": object.blob.contentType,
        "Content-Disposition": `inline; filename="${safeName}"`,
        "X-Content-Type-Options": "nosniff",
        Vary: "Cookie",
        "Cache-Control": story?.status === "published" && !hasOwnerCredential ? "public, max-age=600" : "private, no-store",
      },
    });
  } catch {
    return new Response("Wanderpage media is unavailable.", { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
