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

const forbiddenHostedValue = [/\/Users\//, /\\Users\\/i, /\.trip-output/i, /\.trip-cache/i, /blob:/i, /file:\/\//i];
const credentialPattern = /(?:sk-[a-z0-9_-]{16,}|(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s"']{8,}|postgres(?:ql)?:\/\/)/i;

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

export async function validateHostedStoryOutput(storyId: string, runId: string, manifest: TripManifest, privacy: Story["locationPrivacy"]) {
  const parsed = TripManifestSchema.parse(manifest),
    errors = validateHostedManifestPolicy(parsed, privacy),
    paths = [...new Set(parsed.photos.flatMap(photo => [photo.srcLarge, photo.srcMedium, photo.srcThumb]))],
    expectedPrefix = `/api/media/${storyId}/`;
  if (errors.length) throw new Error(`PRIVACY_FAILED: ${errors.join("; ")}`);
  for (const path of paths) {
    if (!path.startsWith(expectedPrefix)) {
      errors.push(`manifest contains an unowned media path: ${path}`);
      continue;
    }
    const filename = decodeURIComponent(path.slice(expectedPrefix.length)),
      [revision, pathRunId, ...nameParts] = filename.split("--");
    if (!revision || pathRunId !== runId || !nameParts.length) {
      errors.push(`manifest contains a media path outside run ${runId}: ${path}`);
      continue;
    }
    const object = await get(`derivatives/${storyId}/${revision}/${runId}/${nameParts.join("--")}`, { access: "private", useCache: false });
    if (!object || object.statusCode !== 200) {
      errors.push(`derivative is unavailable: ${path}`);
      continue;
    }
    const bytes = Buffer.from(await new Response(object.stream as never).arrayBuffer());
    errors.push(...(await validateHostedDerivative(bytes)).map(error => `${path}: ${error}`));
  }
  if (errors.length) throw new Error(`PRIVACY_FAILED: ${errors.join("; ")}`);
}

export function validateHostedManifestPolicy(manifest: TripManifest, privacy: Story["locationPrivacy"]) {
  const parsed = TripManifestSchema.parse(manifest),
    serialized = JSON.stringify(parsed),
    errors = forbiddenHostedValue.filter(pattern => pattern.test(serialized)).map(pattern => `manifest matched ${pattern}`);
  if (credentialPattern.test(serialized)) errors.push("manifest contains a credential-like value");
  for (const [name, value] of Object.entries(process.env))
    if (/(?:KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)$/i.test(name) && value && value.length > 8 && serialized.includes(value))
      errors.push(`manifest contains configured secret ${name}`);
  if (privacy === "hidden" || privacy === "broad") {
    if (parsed.route.length || parsed.destinations.some(destination => destination.approximateCoordinate))
      errors.push(`${privacy} manifests must not contain coordinates`);
  } else if (
    parsed.route.some(point => hasMoreThanOneDecimal(point.lat) || hasMoreThanOneDecimal(point.lon)) ||
    parsed.destinations.some(
      destination =>
        destination.approximateCoordinate &&
        (hasMoreThanOneDecimal(destination.approximateCoordinate.lat) || hasMoreThanOneDecimal(destination.approximateCoordinate.lon))
    )
  )
    errors.push("approximate manifests must not contain raw coordinate precision");
  return errors;
}

export async function validateHostedDerivative(bytes: Buffer) {
  const metadata = await sharp(bytes).metadata(),
    errors: string[] = [];
  if (metadata.format !== "webp") errors.push("derivative is not WebP");
  if (metadata.exif || metadata.xmp || metadata.iptc) errors.push("derivative contains embedded metadata");
  return errors;
}

function hasMoreThanOneDecimal(value: number) {
  return Math.abs(value * 10 - Math.round(value * 10)) > Number.EPSILON * 10;
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
