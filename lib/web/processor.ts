import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { get, put } from "@vercel/blob";
import sharp from "sharp";
import { runTrip } from "@/lib/pipeline/run";
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";
import type { Story, StoryUpload } from "@/lib/web/types";

export async function processStory(story: Story, uploads: StoryUpload[]) {
  const confirmed = uploads.filter(upload => upload.status === "confirmed");
  if (!confirmed.length) throw new Error("No completed photo uploads are available for processing.");
  const root = await mkdtemp(join(tmpdir(), "wanderpage-web-"));
  try {
    const input = join(root, "input");
    await mkdir(join(root, "data", "trips"), { recursive: true });
    await mkdir(input, { recursive: true });
    await Promise.all(confirmed.map(upload => downloadUpload(upload, input)));
    const result = await runTrip(
      {
        input,
        people: story.peopleMode,
        title: story.title,
        maxPhotos: 36,
        privacy: "approximate",
        force: true,
        dryRun: false,
        demo: false,
      },
      { root }
    );
    const manifest = await uploadDerivatives(root, result.slug, result.manifest, story);
    return { manifest, summary: result.summary };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function downloadUpload(upload: StoryUpload, input: string) {
  const object = await get(upload.blobPath, { access: "private", useCache: false });
  if (!object || object.statusCode !== 200) throw new Error(`Private upload ${upload.id} is unavailable.`);
  const extension = extensionFor(upload.declaredType),
    destination = join(input, `${upload.id}${extension}`);
  await writeFile(destination, Buffer.from(await new Response(object.stream).arrayBuffer()));
  const metadata = await sharp(destination).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 80_000_000)
    throw new Error("An uploaded image is unreadable or exceeds the 80 megapixel limit.");
}

async function uploadDerivatives(root: string, slug: string, manifest: TripManifest, story: Story) {
  const directory = join(root, ".trip-assets", slug),
    names = await readdir(directory),
    byName = new Map<string, string>();
  await Promise.all(
    names.map(async name => {
      const pathname = `derivatives/${story.id}/${name}`;
      await put(pathname, await readFile(join(directory, name)), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "image/webp",
        cacheControlMaxAge: 60 * 60 * 24 * 365,
      });
      byName.set(name, pathname);
    })
  );
  return TripManifestSchema.parse({
    ...applyLocationPrivacy(manifest, story.locationPrivacy),
    photos: manifest.photos.map(photo => ({
      ...photo,
      srcLarge: mediaPath(story.id, byName.get(basename(photo.srcLarge))),
      srcMedium: mediaPath(story.id, byName.get(basename(photo.srcMedium))),
      srcThumb: mediaPath(story.id, byName.get(basename(photo.srcThumb))),
    })),
  });
}

function mediaPath(storyId: string, pathname: string | undefined) {
  if (!pathname) throw new Error("A generated image derivative is missing.");
  return `/api/media/${storyId}/${encodeURIComponent(basename(pathname))}`;
}

export function applyLocationPrivacy(manifest: TripManifest, privacy: Story["locationPrivacy"]): TripManifest {
  if (privacy === "approximate") return manifest;
  if (privacy === "hidden")
    return {
      ...manifest,
      destinations: [],
      route: [],
      chapters: manifest.chapters.map(removeDestinationId),
      photos: manifest.photos.map(removeDestinationId),
    };
  const destinations = manifest.destinations.map(destination => ({
    ...destination,
    name: destination.name.split(",").at(-1)?.trim() || "the surrounding region",
    approximateCoordinate: undefined,
  }));
  return {
    ...manifest,
    destinations,
    route: [],
  };
}

function extensionFor(contentType: StoryUpload["declaredType"]) {
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  return ".webp";
}

function removeDestinationId<T extends { destinationId?: string }>(value: T): Omit<T, "destinationId"> {
  const copy = { ...value };
  delete copy.destinationId;
  return copy;
}
