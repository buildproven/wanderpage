import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get, put } from "@vercel/blob";
import pLimit from "p-limit";
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
    const limit = pLimit(2);
    await Promise.all(confirmed.map(upload => limit(() => downloadUpload(upload, input))));
    const result = await runTrip(
      {
        input,
        people: story.peopleMode,
        title: story.title,
        maxPhotos: 36,
        privacy: story.locationPrivacy,
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
  await pipeline(Readable.fromWeb(object.stream as never), createWriteStream(destination, { flags: "wx" }));
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
      if (!story.activeRunId) throw new Error("A processing story must identify its active run.");
      const objectName = `${story.processorRevision}--${story.activeRunId}--${name}`,
        pathname = `derivatives/${story.id}/${story.processorRevision}/${story.activeRunId}/${name}`;
      await put(pathname, await readFile(join(directory, name)), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "image/webp",
        cacheControlMaxAge: 60 * 60 * 24 * 365,
      });
      byName.set(name, objectName);
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
      subtitle: "A private photographic story.",
      opening: "The photographs are presented without location details.",
      closing: "The story ends without disclosing where the photographs were made.",
      stats: manifest.stats.filter(stat => !/place|destination|route|distance|location/i.test(stat.label)),
      destinations: [],
      route: [],
      chapters: manifest.chapters.map(chapter => ({
        ...removeDestinationId(chapter),
        title: `Chapter ${manifest.chapters.indexOf(chapter) + 1}`,
        narrative: "A sequence assembled from the selected photographs.",
      })),
      photos: manifest.photos.map(photo => ({ ...removeDestinationId(photo), alt: "Selected travel photograph.", caption: undefined })),
      sources: [],
    };
  const destinations = manifest.destinations.map(destination => ({
    ...destination,
    name: destination.name.includes(",")
      ? destination.name.split(",").at(-1)?.trim() || "the surrounding region"
      : "the surrounding region",
    approximateCoordinate: undefined,
    introduction: "",
    facts: [],
  }));
  const regions = [...new Set(destinations.map(destination => destination.name))],
    regionText = regions.length ? regions.join(" and ") : "the surrounding region";
  return {
    ...manifest,
    subtitle: `A photographic story from ${regionText}.`,
    opening: `The selected photographs trace a story through ${regionText}.`,
    closing: "The final frame closes the story without disclosing a precise location.",
    stats: manifest.stats.filter(stat => !/place|destination|route|distance|location/i.test(stat.label)),
    destinations,
    route: [],
    chapters: manifest.chapters.map(chapter => ({
      ...chapter,
      title: destinations.find(destination => destination.id === chapter.destinationId)?.name ?? "The surrounding region",
      narrative: "A sequence assembled from the selected photographs.",
    })),
    photos: manifest.photos.map(photo => ({ ...photo, alt: "Selected travel photograph.", caption: undefined })),
    sources: [],
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
