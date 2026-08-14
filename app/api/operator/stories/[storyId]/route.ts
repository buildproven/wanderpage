import { cleanupStoryObjects } from "@/lib/web/object-cleanup";
import { assertOperatorRequest } from "@/lib/web/operator-auth";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { privateHeaders } from "@/lib/web/http";

export async function DELETE(request: Request, context: { params: Promise<{ storyId: string }> }) {
  try {
    assertOperatorRequest(request);
    const { storyId } = await context.params,
      repository = NeonStoryRepository.fromEnvironment();
    await repository.beginOperatorDeleteStory(storyId, new Date());
    await cleanupStoryObjects(repository, storyId);
    return Response.json({ status: "deleting" }, { status: 202, headers: privateHeaders() });
  } catch (error) {
    if (error instanceof Error && error.message === "OPERATOR_AUTH_REQUIRED") return new Response("Unauthorized", { status: 401 });
    throw error;
  }
}
