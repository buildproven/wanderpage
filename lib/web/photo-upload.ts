// @design DES-WEB-UPLOAD
// The browser side of a photo upload, shared by WebCreator and DraftControls (BUI-2095): reserve each file with
// /api/upload-reservations, then send it straight to private Vercel Blob through /api/uploads, which confirms it.
import { upload } from "@vercel/blob/client";

export type PhotoUploadOptions = {
  storyId: string;
  files: readonly File[];
  csrfToken: string;
  /** Called before each file with its 1-based position. */
  onUploading?: (position: number, total: number) => void;
  /** Called after each file is stored, with the number stored so far. */
  onStored?: (stored: number) => void;
};

/** Uploads the files in order and resolves the number stored; the first refusal rejects with the server's message. */
export async function uploadPhotos({ storyId, files, csrfToken, onUploading, onStored }: PhotoUploadOptions) {
  let stored = 0;
  for (const [index, file] of files.entries()) {
    onUploading?.(index + 1, files.length);
    const reservation = await reserve(storyId, file, csrfToken);
    await upload(reservation.upload.blobPath, file, {
      access: "private",
      handleUploadUrl: "/api/uploads",
      clientPayload: reservation.uploadPayload,
      headers: { "x-wanderpage-csrf": csrfToken },
      contentType: file.type,
    });
    stored += 1;
    onStored?.(stored);
  }
  return stored;
}

async function reserve(storyId: string, file: File, csrfToken: string) {
  const response = await fetch("/api/upload-reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
      body: JSON.stringify({ storyId, originalName: file.name, contentType: file.type, byteSize: file.size }),
    }),
    body = (await response.json()) as { data?: { upload: { blobPath: string }; uploadPayload: string }; error?: { message?: string } };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Wanderpage could not reserve this photo upload.");
  return body.data;
}
