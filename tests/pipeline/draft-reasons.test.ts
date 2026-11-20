import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@/lib/ai/provider";
import { draftWithReasons } from "@/lib/automation/draft-tools";
import { runTrip } from "@/lib/pipeline/run";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "",
  first = "",
  second = "";
const saved = { key: process.env.OPENAI_API_KEY };
const offline = {
  aiProvider: new MockAIProvider(),
  inferDestinations: async () => [],
  enrichDestination: async () => ({ introduction: "", facts: [], sources: [] }),
};
const options = (input: string, title: string, dryRun = false) => ({
  input,
  people: "include" as const,
  title,
  maxPhotos: 36,
  privacy: "hidden" as const,
  force: true,
  dryRun,
  demo: false,
});
type Selection = { selected: string[]; reasons: Record<string, string> };
type ReasonsRecord = { generatedAt: string; reasons: Record<string, string> };
const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

beforeAll(async () => {
  workspace = await createTempWorkspace("draft-reasons");
  first = await createPhotoFolder(join(workspace, "first"), { count: 4, gps: false });
  // Re-encoded copies: the same scenes, but new files and therefore new photo IDs.
  second = join(workspace, "second");
  const source = await createPhotoFolder(join(workspace, "second-source"), { count: 4, gps: false });
  await mkdir(second, { recursive: true });
  for (const name of (await readdir(source)).filter(file => file.endsWith(".jpg")))
    await sharp(join(source, name)).jpeg({ quality: 61 }).toFile(join(second, name));
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});
beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.key;
});

// @verifies DES-PIPE-RUN, ARCH-PIPELINE, DES-MCP-TOOLS
describe("runTrip keeps each draft's selection reasons", () => {
  // @verifies REQ-MCP-4
  it("records the reasons of every draft photo under the draft's slug, tied to its generatedAt", async () => {
    const root = join(workspace, "record");
    const run = await runTrip(options(first, "Record Trip"), { ...offline, root });
    const selection = await readJson<Selection>(join(root, ".trip-output/selection.json")),
      record = await readJson<ReasonsRecord>(join(root, ".trip-output/reasons", `${run.slug}.json`)),
      draftFile = await readJson<{ generatedAt: string }>(join(root, "data/trips", `${run.slug}.json`));

    expect(record.generatedAt).toBe(draftFile.generatedAt);
    expect(Object.keys(record.reasons).sort()).toEqual(run.manifest.photos.map(photo => photo.id).sort());
    for (const photo of run.manifest.photos) expect(record.reasons[photo.id]).toBe(selection.reasons[photo.id]);
  });

  // @verifies REQ-MCP-4
  it("keeps an earlier draft's reasons after a later run overwrites selection.json", async () => {
    const root = join(workspace, "two-runs");
    const earlier = await runTrip(options(first, "Earlier Trip"), { ...offline, root });
    const earlierReasons = (await readJson<Selection>(join(root, ".trip-output/selection.json"))).reasons;
    const later = await runTrip(options(second, "Later Trip"), { ...offline, root });
    expect(later.slug).not.toBe(earlier.slug);

    const latest = await readJson<Selection>(join(root, ".trip-output/selection.json"));
    expect(earlier.manifest.photos.some(photo => !latest.selected.includes(photo.id))).toBe(true);

    const draft = await draftWithReasons(root, earlier.slug);
    expect(draft.photos.length).toBeGreaterThan(0);
    for (const photo of draft.photos) {
      expect(photo.reason).toBe(earlierReasons[photo.id]);
      expect(photo.reason).toMatch(/^Selected:/);
    }
  });

  // @verifies REQ-MCP-4
  it("writes no reasons record on a dry run, which saves no draft", async () => {
    const root = join(workspace, "dry-run");
    const run = await runTrip(options(first, "Dry Trip", true), { ...offline, root });
    await expect(readFile(join(root, ".trip-output/reasons", `${run.slug}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
