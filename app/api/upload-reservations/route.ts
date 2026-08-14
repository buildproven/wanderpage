import { apiError, data, privateHeaders } from "@/lib/web/http";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { getStoryService } from "@/lib/web/runtime";
import { assertMutationRequest, ownerSecret } from "@/lib/web/session";
import { UploadService } from "@/lib/web/upload-service";

export async function POST(request: Request) {
  try {
    const input = await request.json(),
      stories = getStoryService(),
      secret = await ownerSecret(),
      session = await stories.requireSession(secret);
    assertMutationRequest(request, session);
    const upload = await new UploadService(NeonStoryRepository.fromEnvironment(), stories).reserve(secret!, input);
    return data({ upload, uploadPayload: JSON.stringify({ uploadId: upload.id, storyId: upload.storyId }) }, 201, {
      headers: privateHeaders(),
    });
  } catch (error) {
    return apiError(error);
  }
}
