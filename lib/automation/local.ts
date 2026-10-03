// @design DES-CLI-AGENT
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { discoverPhotos } from "@/lib/photos/ingest";
import { validateStaticExport } from "@/lib/publishing/privacy";
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";
import { getTrip, listTrips, setTripPublished } from "@/lib/trips/publish";

export const contractVersion = "wanderpage/v1";
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export type Operation = "inspect" | "list" | "show" | "validate" | "publish" | "unpublish";

export class LocalCommandError extends Error {
  constructor(
    readonly code: "INVALID_ARGUMENT" | "VALIDATION_FAILED" | "NOT_FOUND",
    message: string
  ) {
    super(message);
  }
}

export type Receipt = { id: string; changed: boolean; manifestDigest?: string; assetTreeDigest?: string };
export type Result<T> = { contractVersion: typeof contractVersion; operation: Operation; ok: true; data: T; receipt: Receipt };

export async function workspace(input?: string) {
  const candidate = resolve(input ?? process.cwd());
  try {
    const value = await realpath(candidate);
    if (!(await stat(value)).isDirectory()) throw new Error("not a directory");
    return value;
  } catch {
    throw new LocalCommandError("NOT_FOUND", `Workspace not found: ${candidate}`);
  }
}

export async function inspectPhotos(input: string) {
  const folder = await realDirectory(input, "Photo folder");
  return { input: folder, supportedPhotos: (await discoverPhotos(folder)).length };
}

export async function readDraft(root: string, slug: string) {
  assertSlug(slug);
  await assertPrivatePath(root, join("data", "trips", `${slug}.json`));
  const manifest = await getTrip(root, slug);
  if (!manifest) throw new LocalCommandError("NOT_FOUND", `Draft not found: ${slug}`);
  return manifest;
}

export async function validateDraft(root: string, slug: string) {
  const manifest = await readDraft(root, slug);
  const manifestPath = await assertPrivatePath(root, join("data", "trips", `${slug}.json`));
  const assets = await assertPrivatePath(root, join(".trip-assets", slug));
  const [manifestPrivacy, assetPrivacy, manifestDigest, assetTreeDigest] = await Promise.all([
    validateStaticExport(join(root, "data", "trips")),
    validateStaticExport(assets),
    digestFile(manifestPath),
    digestTree(assets),
  ]);
  const errors = [...manifestPrivacy.errors, ...assetPrivacy.errors];
  if (errors.length) throw new LocalCommandError("VALIDATION_FAILED", `Privacy validation failed: ${errors.join("; ")}`);
  return { manifest, manifestDigest, assetTreeDigest, validatedFiles: manifestPrivacy.files.length + assetPrivacy.files.length };
}

export async function publishDraft(root: string, slug: string, published: boolean) {
  const validation = await validateDraft(root, slug);
  const manifest = await setTripPublished(root, slug, published);
  return { ...validation, manifest };
}

export async function drafts(root: string) {
  return (await listTrips(root)).map(({ slug, manifest }) => ({ slug, title: manifest.title, published: manifest.published }));
}

export function result<T>(operation: Operation, data: T, receipt: Omit<Receipt, "id">): Result<T> {
  return { contractVersion, operation, ok: true, data, receipt: { id: randomUUID(), ...receipt } };
}

export function error(operation: Operation, value: unknown) {
  const commandError =
    value instanceof LocalCommandError
      ? value
      : new LocalCommandError("VALIDATION_FAILED", value instanceof Error ? value.message : String(value));
  return { contractVersion, operation, ok: false as const, error: { code: commandError.code, message: commandError.message } };
}

export function exitCode(value: unknown) {
  if (!(value instanceof LocalCommandError)) return 10;
  return value.code === "INVALID_ARGUMENT" ? 2 : value.code === "NOT_FOUND" ? 4 : 3;
}

function assertSlug(slug: string) {
  if (!slugPattern.test(slug))
    throw new LocalCommandError("INVALID_ARGUMENT", "Draft slug must contain only lowercase letters, numbers, and hyphens.");
}

async function realDirectory(input: string, label: string) {
  const candidate = resolve(input);
  try {
    const value = await realpath(candidate);
    if (!(await stat(value)).isDirectory()) throw new Error("not a directory");
    return value;
  } catch {
    throw new LocalCommandError("NOT_FOUND", `${label} not found: ${candidate}`);
  }
}

async function assertPrivatePath(root: string, child: string) {
  const candidate = resolve(root, child);
  if (relative(root, candidate).startsWith("..")) throw new LocalCommandError("INVALID_ARGUMENT", "Path escapes the workspace.");
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) throw new LocalCommandError("VALIDATION_FAILED", "Symbolic links are not allowed in draft paths.");
    const actual = await realpath(candidate);
    if (relative(root, actual).startsWith("..")) throw new LocalCommandError("VALIDATION_FAILED", "Draft path escapes the workspace.");
    return actual;
  } catch (error) {
    if (error instanceof LocalCommandError) throw error;
    throw new LocalCommandError("NOT_FOUND", `Required draft artifact is missing: ${basename(candidate)}`);
  }
}

async function digestFile(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function digestTree(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const digest = createHash("sha256");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new LocalCommandError("VALIDATION_FAILED", "Symbolic links are not allowed in draft assets.");
    digest.update(entry.name);
    digest.update(entry.isDirectory() ? await digestTree(child) : await digestFile(child));
  }
  return digest.digest("hex");
}

export function parseManifest(value: unknown): TripManifest {
  return TripManifestSchema.parse(value);
}
