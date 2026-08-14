import { z } from "zod";
import { apiError, data, privateHeaders } from "@/lib/web/http";
import { getStoryService } from "@/lib/web/runtime";
import { assertMutationRequest, ownerSecret } from "@/lib/web/session";
import { storyDto } from "@/lib/web/dto";

const actionSchema = z.object({ action: z.enum(["publish", "unpublish"]) });

export async function POST(request: Request, context: { params: Promise<{ storyId: string }> }) {
  try {
    const { storyId } = await context.params,
      { action } = actionSchema.parse(await request.json()),
      stories = getStoryService(),
      secret = await ownerSecret(),
      session = await stories.requireSession(secret);
    assertMutationRequest(request, session);
    const story = action === "publish" ? await stories.publish(secret!, storyId) : await stories.unpublish(secret!, storyId);
    return data({ story: storyDto(story) }, 200, { headers: privateHeaders() });
  } catch (error) {
    return apiError(error);
  }
}
