// @design DES-MCP-TOOLS
// Relative imports only: tsx does not apply tsconfig "@/" paths to files under node_modules.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTrip, type RunDependencies } from "../pipeline/run";
import type { TripManifest } from "../schemas/trip";
import { readDraft, realDirectory } from "./local";

export type CreateDraftInput = {
  folder: string;
  people: "include" | "exclude";
  locationPrivacy: "hidden" | "broad" | "approximate" | "precise";
  title?: string;
  maxPhotos?: number;
};

/** Same default as `pnpm trip`. */
export const defaultMaxPhotos = 36;

// One pipeline run or draft mutation at a time: runs share `.trip-output/`, the published assets, `out/`, and the process console.
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export function createDraft(root: string, input: CreateDraftInput, dependencies: Omit<RunDependencies, "root"> = {}) {
  return exclusive(async () => {
    const folder = await realDirectory(input.folder, "Photo folder"),
      requested = input.maxPhotos ?? defaultMaxPhotos;
    const run = await runTrip(
      {
        input: folder,
        people: input.people,
        title: input.title,
        maxPhotos: requested,
        privacy: input.locationPrivacy,
        force: false,
        dryRun: false,
        demo: false,
      },
      { ...dependencies, root }
    );
    await recordReasons(root, run.slug, run.manifest);
    const selected = run.manifest.photos.length;
    return {
      slug: run.slug,
      summary: {
        title: run.manifest.title,
        subtitle: run.manifest.subtitle,
        published: run.manifest.published,
        peopleMode: run.manifest.peopleMode,
        locationPrivacy: input.locationPrivacy,
        dateRange: run.manifest.dateRange ?? null,
        inputPhotos: run.summary.inputPhotos,
        duplicatesRemoved: run.summary.duplicatesRemoved,
        lowQualityRejected: run.summary.lowQualityRejected,
        requestedMaxPhotos: requested,
        selectedPhotos: selected,
        destinations: run.manifest.destinations.map(destination => destination.name),
        chapters: run.manifest.chapters.length,
        basicEdit: "basicEdit" in run.summary ? run.summary.basicEdit : false,
        note:
          selected > requested
            ? `You asked for at most ${requested} photos. The selection rule picks at least 18 photos (or every photo when there are fewer), so ${selected} were selected.`
            : undefined,
      },
    };
  });
}

/** The manifest plus why each of its photos was selected (`reason` is null when no record of the selection exists). */
export async function draftWithReasons(root: string, slug: string) {
  const manifest = await readDraft(root, slug),
    reasons = await recordedReasons(root, slug, manifest);
  return { slug, manifest, photos: manifest.photos.map(photo => ({ id: photo.id, reason: reasons[photo.id] ?? null })) };
}

async function recordReasons(root: string, slug: string, manifest: TripManifest) {
  const selection = await readSelection(root);
  if (!selection) return;
  const reasons = Object.fromEntries(
    manifest.photos.flatMap(photo => (selection.reasons[photo.id] ? [[photo.id, selection.reasons[photo.id]]] : []))
  );
  await mkdir(join(root, ".trip-output/reasons"), { recursive: true });
  // generatedAt ties the record to this run: a later draft under the same slug (after a delete or a re-run by Studio or the CLI) gets a new one.
  await writeFile(
    join(root, ".trip-output/reasons", `${slug}.json`),
    JSON.stringify({ generatedAt: manifest.generatedAt, reasons }, null, 2)
  );
}

async function recordedReasons(root: string, slug: string, manifest: TripManifest): Promise<Record<string, string>> {
  const own = (await readJson(join(root, ".trip-output/reasons", `${slug}.json`))) as
    { generatedAt?: unknown; reasons?: unknown } | undefined;
  if (own && typeof own === "object" && own.generatedAt === manifest.generatedAt && isStringMap(own.reasons)) return own.reasons;
  // A draft made by Studio or the CLI has no current per-draft record; the latest run's selection applies only if it produced this draft.
  const selection = await readSelection(root);
  if (selection && manifest.photos.every(photo => selection.selected.includes(photo.id))) return selection.reasons;
  return {};
}

async function readSelection(root: string) {
  const value = await readJson(join(root, ".trip-output/selection.json"));
  if (!value || typeof value !== "object") return undefined;
  const { selected, reasons } = value as { selected?: unknown; reasons?: unknown };
  if (!Array.isArray(selected) || !selected.every(id => typeof id === "string") || !isStringMap(reasons)) return undefined;
  return { selected: selected as string[], reasons };
}

async function readJson(path: string): Promise<unknown> {
  return readFile(path, "utf8")
    .then(text => JSON.parse(text) as unknown)
    .catch(() => undefined);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
}
