// @design DES-MCP-PUBLISH
// Relative imports only: tsx does not apply tsconfig "@/" paths to files under node_modules.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildContactSheet } from "../ai/contact-sheet";
import { deployAfterPrivacyScan, PrivacyScanError } from "../publishing/privacy";
import type { TripManifest } from "../schemas/trip";
import { runStaticExport } from "../static-export-run";
import { syncPublishedAssets } from "../trips/assets";
import { normalizeDraft } from "../trips/draft";
import { setTripPublished, writeTrip } from "../trips/publish";
import { exclusive } from "./draft-tools";
import { assertPrivatePath, LocalCommandError, readDraft, validateDraft } from "./local";

export type DraftChanges = {
  removePhotoIds?: string[];
  heroPhotoId?: string;
  title?: string;
  captions?: Array<{ photoId: string; caption: string }>;
};

/** Tiles per contact sheet (`buildContactSheet` lays out 4 x 4). */
export const photosPerSheet = 16;

/**
 * Applies chat edits to a private draft through the same `normalizeDraft` check Studio uses. Every change is checked against the draft
 * before anything is written, so a rejected edit leaves the draft file unchanged.
 */
export function editDraft(root: string, slug: string, changes: DraftChanges) {
  return exclusive(async () => {
    const manifest = await readDraft(root, slug);
    if (manifest.published)
      throw new LocalCommandError(
        "VALIDATION_FAILED",
        `Draft ${slug} is published. Unpublish it (\`wanderpage unpublish ${slug}\` or Studio) before editing it.`
      );
    const { removePhotoIds = [], heroPhotoId, title, captions = [] } = changes;
    if (!removePhotoIds.length && heroPhotoId === undefined && title === undefined && !captions.length)
      throw new LocalCommandError("INVALID_ARGUMENT", "Give at least one change: removePhotoIds, heroPhotoId, title, or captions.");
    const ids = new Set(manifest.photos.map(photo => photo.id)),
      removed = new Set(removePhotoIds);
    const unknown = [...removed, ...(heroPhotoId === undefined ? [] : [heroPhotoId]), ...captions.map(item => item.photoId)].filter(
      id => !ids.has(id)
    );
    if (unknown.length) throw new LocalCommandError("INVALID_ARGUMENT", `Photo not in draft ${slug}: ${[...new Set(unknown)].join(", ")}`);
    if (heroPhotoId !== undefined && removed.has(heroPhotoId))
      throw new LocalCommandError("INVALID_ARGUMENT", `Photo ${heroPhotoId} cannot be both removed and the hero.`);
    const removedCaption = captions.find(item => removed.has(item.photoId));
    if (removedCaption)
      throw new LocalCommandError("INVALID_ARGUMENT", `Photo ${removedCaption.photoId} is removed, so it has no caption.`);
    const caption = new Map(captions.map(item => [item.photoId, item.caption.trim()]));
    const photos = manifest.photos
      .filter(photo => !removed.has(photo.id))
      .map(photo => {
        if (!caption.has(photo.id)) return photo;
        const text = caption.get(photo.id)!;
        return { ...photo, caption: text || undefined };
      });
    const draft = normalizeDraft({
      ...manifest,
      published: false,
      title: title?.trim() ?? manifest.title,
      heroPhotoId: heroPhotoId ?? manifest.heroPhotoId,
      photos,
    });
    return { slug, manifest: await writeTrip(root, slug, draft) };
  });
}

/** Contact sheets (JPEG, base64) of the draft's photos in story order, tiled from the published medium WebP files, never the originals. */
export async function previewDraft(root: string, slug: string) {
  const manifest = await readDraft(root, slug);
  const tiles = await Promise.all(
    manifest.photos.map(async photo => {
      const name = basename(photo.srcMedium);
      if (photo.srcMedium !== `/trip/generated/${slug}/${name}` || !/^[a-z0-9-]+-medium\.webp$/i.test(name))
        throw new LocalCommandError("VALIDATION_FAILED", `Photo ${photo.id} has no published WebP image in draft ${slug}.`);
      return { id: photo.id, analysisPath: await assertPrivatePath(root, join(".trip-assets", slug, name)) };
    })
  );
  const directory = await mkdtemp(join(tmpdir(), "wanderpage-preview-"));
  try {
    const sheets: string[] = [];
    for (let start = 0; start < tiles.length; start += photosPerSheet) {
      const sheet = await buildContactSheet(tiles.slice(start, start + photosPerSheet), join(directory, `sheet-${sheets.length + 1}.jpg`));
      sheets.push((await readFile(sheet)).toString("base64"));
    }
    return { slug, title: manifest.title, heroPhotoId: manifest.heroPhotoId, photoIds: tiles.map(tile => tile.id), sheets };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export type PublishOptions = {
  /** Builds the static site into `<root>/out`; defaults to the project's static export. */
  buildSite?: (root: string) => Promise<void>;
  /** Hosting step, run only after the privacy scan passes. None by default: `out/` is the shareable site. */
  deploy?: (outputPath: string) => Promise<void>;
};

/**
 * Publishes a draft, rebuilds the static site, and scans it through the privacy-gated deploy path. On any failure the draft goes back
 * to its previous state and the site is rebuilt without it, so a site that fails the scan is never deployed.
 */
export function publishSite(
  root: string,
  slug: string,
  { buildSite = runStaticExport, deploy = async () => undefined }: PublishOptions = {}
) {
  return exclusive(async () => {
    const original = await readDraft(root, slug),
      outputPath = join(root, "out");
    // Same revalidation as `wanderpage publish`; it writes nothing, so a refusal here needs no rollback.
    const { manifestDigest, assetTreeDigest } = await validateDraft(root, slug);
    try {
      const manifest = await setTripPublished(root, slug, true);
      await buildSite(root);
      const scan = await deployAfterPrivacyScan({ outputPath, deploy: () => deploy(outputPath) });
      if (!scan.deployed) throw new PrivacyScanError(scan.findings);
      return {
        slug,
        title: manifest.title,
        published: manifest.published,
        path: `/trips/${slug}`,
        outputPath,
        privacy: { passed: true, scannedFiles: scan.files, findings: scan.findings },
        manifestDigest,
        assetTreeDigest,
      };
    } catch (error) {
      await restore(root, slug, original, buildSite, error);
      throw error;
    }
  });
}

async function restore(root: string, slug: string, original: TripManifest, buildSite: (root: string) => Promise<void>, cause: unknown) {
  try {
    await writeTrip(root, slug, original);
    await syncPublishedAssets(root);
    await buildSite(root);
  } catch (rollback) {
    throw new Error(`${message(cause)}\nAdditionally, restoring the draft and rebuilding out/ failed: ${message(rollback)}`, {
      cause: rollback,
    });
  }
}

function message(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
