import { apiError, data, privateHeaders } from "@/lib/web/http";
import { getStoryService } from "@/lib/web/runtime";
import { assertMutationRequest, ownerSecret } from "@/lib/web/session";

export async function POST(request: Request, context: { params: Promise<{ storyId: string }> }) {
  try {
    const { storyId } = await context.params,
      stories = getStoryService(),
      secret = await ownerSecret(),
      session = await stories.requireSession(secret);
    assertMutationRequest(request, session);
    return data({ story: await stories.queueGeneration(secret!, storyId) }, 202, { headers: privateHeaders() });
  } catch (error) {
    return apiError(error);
  }
}
