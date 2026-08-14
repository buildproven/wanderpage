import { z } from "zod";
import { apiError, data, privateHeaders } from "@/lib/web/http";
import { getStoryService } from "@/lib/web/runtime";
import { assertMutationRequest, ownerSecret } from "@/lib/web/session";
import { StoryServiceError } from "@/lib/web/story-service";
import { cleanupStoryObjects } from "@/lib/web/object-cleanup";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { LocationPrivacyModes, PeopleModes } from "@/lib/web/types";

const editSchema = z.object({
  version: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(120),
  peopleMode: z.enum(PeopleModes),
  locationPrivacy: z.enum(LocationPrivacyModes),
});

export async function GET(_request: Request, context: { params: Promise<{ storyId: string }> }) {
  try {
    const { storyId } = await context.params,
      stories = getStoryService(),
      secret = await ownerSecret();
    if (!secret) throw new StoryServiceError("AUTH_REQUIRED", "Start a private Wanderpage story first.");
    return data({ story: await stories.getOwnedStory(secret, storyId) }, 200, { headers: privateHeaders() });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ storyId: string }> }) {
  try {
    const { storyId } = await context.params,
      changes = editSchema.parse(await request.json()),
      stories = getStoryService(),
      secret = await ownerSecret(),
      session = await stories.requireSession(secret);
    assertMutationRequest(request, session);
    return data({ story: await stories.updateStory(secret!, storyId, changes.version, changes) }, 200, { headers: privateHeaders() });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ storyId: string }> }) {
  try {
    const { storyId } = await context.params,
      stories = getStoryService(),
      secret = await ownerSecret(),
      session = await stories.requireSession(secret);
    assertMutationRequest(request, session);
    const deletion = await stories.prepareDelete(secret!, storyId);
    if (!deletion.alreadyDeleted) {
      await cleanupStoryObjects(NeonStoryRepository.fromEnvironment(), storyId);
    }
    return new Response(null, { status: 204, headers: privateHeaders() });
  } catch (error) {
    return apiError(error);
  }
}
