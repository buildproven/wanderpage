import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoryRepository, StoryUpload } from "@/lib/web/types";
import { StoryService, StoryServiceError } from "@/lib/web/story-service";
import { maxPhotoBytes, maxStoryBytes, maxStoryPhotos } from "@/lib/web/limits";

export const allowedPhotoTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export { maxPhotoBytes, maxStoryBytes, maxStoryPhotos, minStoryPhotos } from "@/lib/web/limits";

const requestSchema = z.object({
  storyId: z.string().uuid(),
  originalName: z.string().trim().min(1).max(255),
  contentType: z.enum(allowedPhotoTypes),
  byteSize: z.number().int().positive().max(maxPhotoBytes),
});

const tokenPayloadSchema = z.object({ uploadId: z.string().uuid(), storyId: z.string().uuid() });

export class UploadService {
  constructor(
    private readonly repository: StoryRepository,
    private readonly stories: StoryService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async reserve(rawSecret: string, value: unknown) {
    const request = requestSchema.parse(value),
      story = await this.stories.getOwnedStory(rawSecret, request.storyId);
    if (story.status !== "uploading") throw new StoryServiceError("INVALID_STATE", "Photos can only be added before generation starts.");
    const uploads = await this.repository.listUploads(story.id),
      active = uploads.filter(upload => upload.status === "reserved" || upload.status === "confirmed"),
      reservedBytes = active.reduce((total, upload) => total + (upload.byteSize ?? 0), 0);
    if (active.length >= maxStoryPhotos)
      throw new StoryServiceError("VALIDATION_ERROR", `A Wanderpage story supports at most ${maxStoryPhotos} photos.`);
    if (reservedBytes + request.byteSize > maxStoryBytes)
      throw new StoryServiceError("VALIDATION_ERROR", "This story would exceed the 500 MiB upload limit.");
    const now = this.now(),
      upload: StoryUpload = {
        id: randomUUID(),
        storyId: story.id,
        blobPath: `sources/${story.id}/${randomUUID()}`,
        originalName: request.originalName,
        declaredType: request.contentType,
        byteSize: request.byteSize,
        status: "reserved",
        createdAt: now,
      };
    await this.repository.createUpload(upload);
    return upload;
  }

  async confirm(payload: unknown, blob: { pathname: string; contentType: string }) {
    const token = tokenPayloadSchema.parse(payload),
      upload = await this.repository.findUpload(token.uploadId);
    if (!upload || upload.storyId !== token.storyId || upload.status !== "reserved")
      throw new Error("Upload callback does not match a reserved upload.");
    if (blob.pathname !== upload.blobPath || blob.contentType !== upload.declaredType)
      throw new Error("Uploaded object does not match its authorized upload contract.");
    // Vercel Blob enforces the signed token's maximum size before this callback.
    await this.repository.saveUpload({ ...upload, status: "confirmed", detectedType: blob.contentType, confirmedAt: this.now() });
  }

  async authorize(rawSecret: string, payload: unknown, pathname: string) {
    const token = tokenPayloadSchema.parse(payload),
      upload = await this.repository.findUpload(token.uploadId);
    await this.stories.getOwnedStory(rawSecret, token.storyId);
    if (!upload || upload.storyId !== token.storyId || upload.status !== "reserved" || upload.blobPath !== pathname)
      throw new StoryServiceError("FORBIDDEN", "This upload authorization does not match its private reservation.");
    return upload;
  }

  payload(upload: StoryUpload) {
    return JSON.stringify({ uploadId: upload.id, storyId: upload.storyId });
  }
}
