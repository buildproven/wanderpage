import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { del } from "@vercel/blob";
import { apiError } from "@/lib/web/http";
import { blobClientResponse } from "@/lib/web/blob-response";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { getStoryService } from "@/lib/web/runtime";
import { assertMutationRequest, ownerSecret } from "@/lib/web/session";
import { StoryServiceError } from "@/lib/web/story-service";
import { maxPhotoBytes, UploadService } from "@/lib/web/upload-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody,
      repository = NeonStoryRepository.fromEnvironment(),
      stories = getStoryService(),
      uploads = new UploadService(repository, stories),
      token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is required for private uploads.");

    const result = await handleUpload({
      body,
      request,
      token,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const secret = await ownerSecret(),
          session = await stories.requireSession(secret),
          payload = clientPayload ? JSON.parse(clientPayload) : undefined;
        try {
          assertMutationRequest(request, session);
        } catch {
          throw new StoryServiceError("FORBIDDEN", "This upload request could not be verified.");
        }
        const upload = await uploads.authorize(secret!, payload, pathname);
        return {
          allowedContentTypes: [upload.declaredType],
          maximumSizeInBytes: upload.byteSize ?? maxPhotoBytes,
          validUntil: Date.now() + 15 * 60 * 1000,
          addRandomSuffix: false,
          allowOverwrite: false,
          tokenPayload: uploads.payload(upload),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        try {
          await uploads.confirm(tokenPayload ? JSON.parse(tokenPayload) : undefined, blob);
        } catch (error) {
          await del(blob.pathname);
          throw error;
        }
      },
    });
    return blobClientResponse(result);
  } catch (error) {
    return apiError(error);
  }
}
