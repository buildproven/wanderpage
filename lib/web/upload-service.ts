import { randomUUID } from "node:crypto";
import { get } from "@vercel/blob";
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
    private readonly now: () => Date = () => new Date(),
    private readonly inspect: (pathname: string) => Promise<string> = inspectPrivateImage
  ) {}

  async reserve(rawSecret: string, value: unknown) {
    this.stories.assertGenerationOpen();
    const request = requestSchema.parse(value),
      story = await this.stories.getOwnedStory(rawSecret, request.storyId);
    if (story.status !== "uploading") throw new StoryServiceError("INVALID_STATE", "Photos can only be added before generation starts.");
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
    try {
      await this.repository.reserveUpload(upload, { maxPhotos: maxStoryPhotos, maxBytes: maxStoryBytes });
    } catch (error) {
      if (error instanceof Error && error.message === "UPLOAD_COUNT_LIMIT")
        throw new StoryServiceError("VALIDATION_ERROR", `A Wanderpage story supports at most ${maxStoryPhotos} photos.`);
      if (error instanceof Error && error.message === "UPLOAD_BYTES_LIMIT")
        throw new StoryServiceError("VALIDATION_ERROR", "This story would exceed the 500 MiB upload limit.");
      if (error instanceof Error && error.message === "UPLOAD_STATE_CONFLICT")
        throw new StoryServiceError("INVALID_STATE", "Photos can only be added before generation starts.");
      if (error instanceof Error && error.message === "SESSION_UPLOAD_LIMIT")
        throw new StoryServiceError("INVALID_STATE", "Finish or delete the other active upload before adding photos to this story.");
      throw error;
    }
    return upload;
  }

  async confirm(payload: unknown, blob: { pathname: string; contentType: string }) {
    const token = tokenPayloadSchema.parse(payload),
      upload = await this.repository.findUpload(token.uploadId),
      story = await this.repository.findStory(token.storyId);
    if (!story || story.status !== "uploading") throw new Error("Story no longer accepts upload confirmation.");
    if (!upload || upload.storyId !== token.storyId || upload.status !== "reserved")
      throw new Error("Upload callback does not match a reserved upload.");
    if (blob.pathname !== upload.blobPath || blob.contentType !== upload.declaredType)
      throw new Error("Uploaded object does not match its authorized upload contract.");
    const detectedType = await this.inspect(upload.blobPath);
    if (detectedType !== upload.declaredType) throw new Error("Uploaded bytes do not match the declared image type.");
    // Vercel Blob enforces the signed token's maximum size before this callback.
    try {
      await this.repository.confirmUpload({ ...upload, status: "confirmed", detectedType, confirmedAt: this.now() });
    } catch (error) {
      if (error instanceof Error && error.message === "UPLOAD_STATE_CONFLICT")
        throw new Error("Story no longer accepts upload confirmation.");
      throw error;
    }
  }

  async authorize(rawSecret: string, payload: unknown, pathname: string) {
    this.stories.assertGenerationOpen();
    const token = tokenPayloadSchema.parse(payload),
      upload = await this.repository.findUpload(token.uploadId),
      story = await this.stories.getOwnedStory(rawSecret, token.storyId);
    if (story.status !== "uploading") throw new StoryServiceError("INVALID_STATE", "This story no longer accepts photos.");
    if (!upload || upload.storyId !== token.storyId || upload.status !== "reserved" || upload.blobPath !== pathname)
      throw new StoryServiceError("FORBIDDEN", "This upload authorization does not match its private reservation.");
    return upload;
  }

  payload(upload: StoryUpload) {
    return JSON.stringify({ uploadId: upload.id, storyId: upload.storyId });
  }
}

async function inspectPrivateImage(pathname: string) {
  const object = await get(pathname, { access: "private", useCache: false });
  if (!object || object.statusCode !== 200) throw new Error("Uploaded object is unavailable for verification.");
  const reader = object.stream.getReader(),
    bytes: number[] = [];
  try {
    while (bytes.length < 12) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.push(...value.slice(0, 12 - bytes.length));
    }
  } finally {
    await reader.cancel();
  }
  return detectImageType(Uint8Array.from(bytes));
}

export function detectImageType(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value))
    return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
    return "image/webp";
  throw new Error("Uploaded bytes are not a supported image.");
}
