import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, Narrative } from "@/lib/ai/provider";
import type { DestinationEvidence } from "@/lib/location/infer";
import type { PhotoRecord } from "@/lib/photos/types";
import { runTrip } from "@/lib/pipeline/run";
import { TripManifestSchema } from "@/lib/schemas/trip";
import { createPhotoFolder, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "",
  input = "";
const saved = { key: process.env.OPENAI_API_KEY };
beforeAll(async () => {
  workspace = await createTempWorkspace("pipeline");
  input = await createPhotoFolder(workspace, { count: 8 });
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
  vi.unstubAllGlobals();
  if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.key;
});

const options = (title: string, extra: Partial<Parameters<typeof runTrip>[0]> = {}) => ({
  input,
  people: "include" as const,
  title,
  maxPhotos: 12,
  privacy: "approximate" as const,
  force: true,
  dryRun: false,
  demo: false,
  ...extra,
});

class FakeProvider implements AIProvider {
  async analyzeContactSheet(_path: string, ids: string[]) {
    return ids.map((photoId, index) => ({
      photoId,
      containsPeople: index % 2 === 0,
      peopleProminence: index % 2 === 0 ? ("prominent" as const) : ("none" as const),
      aestheticScore: 90 - index,
      storyScore: 70,
      landmarkValue: 70,
      emotionalValue: 40,
      uniquenessScore: 70,
      categories: ["landscape" as const],
      possibleLocations: [{ label: "Cannon Beach", confidence: 0.8, evidence: "Haystack Rock is visible" }],
      captionSeed: "Haystack Rock at low tide.",
    }));
  }
  async generateNarrative(): Promise<Narrative> {
    return { title: "T", subtitle: "S", opening: "O", closing: "C", chapterNarratives: ["N"], captions: [] };
  }
}

const place = async (photos: PhotoRecord[]): Promise<DestinationEvidence[]> => [
  {
    id: "destination-1",
    name: "Cannon Beach",
    confidence: 0.96,
    lat: 45.88213,
    lon: -123.96221,
    photoIds: photos.filter(photo => photo.gps).map(photo => photo.id),
    evidence: ["Nearby Wikidata/Wikipedia entity: Cannon Beach"],
  },
];
const enrich = async () => ({ introduction: "Sourced intro.", facts: [], sources: [] });
const manifestOf = async (slug: string) =>
  TripManifestSchema.parse(JSON.parse(await readFile(join(workspace, "data/trips", `${slug}.json`), "utf8")));

// @verifies DES-PIPE-RUN, ARCH-PIPELINE, REQ-AI-05, ARCH-VISION, SN-06, SN-07
describe("basic edit without an API key", () => {
  it("announces itself in progress, console, summary, and report", async () => {
    const progress: string[] = [];
    const result = await runTrip(options("Basic Edit"), {
      root: workspace,
      inferDestinations: async () => [],
      onProgress: event => progress.push(event.message),
    });
    expect(progress.some(message => message.startsWith("Basic edit:"))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Basic edit:"));
    expect(result.summary).toMatchObject({ provider: "deterministic-mock", basicEdit: true });
    const report = await readFile(join(workspace, ".trip-output/report/index.html"), "utf8");
    expect(report).toContain("Basic edit:");
  });

  it("does not claim a basic edit when a provider is supplied", async () => {
    const result = await runTrip(options("Real Edit"), {
      root: workspace,
      aiProvider: new FakeProvider(),
      inferDestinations: async () => [],
      enrichDestination: enrich,
    });
    expect(result.summary).toMatchObject({ basicEdit: false });
  });
});

// @verifies DES-PIPE-RUN, REQ-SEL-02, ARCH-CURATE, SN-02
describe("strict people exclusion", () => {
  it("fails before any work when no key or provider is available", async () => {
    await expect(runTrip(options("No Key", { people: "exclude" }), { root: workspace })).rejects.toThrow(/OPENAI_API_KEY is required/);
    await expect(readdir(join(workspace, ".trip-cache"))).resolves.not.toContain("no-key");
  });

  it("publishes no photo the analysis marked as containing a person", async () => {
    await runTrip(options("Exclude People", { people: "exclude" }), {
      root: workspace,
      aiProvider: new FakeProvider(),
      inferDestinations: place,
      enrichDestination: enrich,
    });
    const manifest = await manifestOf("exclude-people");
    expect(manifest.peopleMode).toBe("exclude");
    expect(manifest.photos.length).toBeGreaterThan(0);
    expect(manifest.photos.every(photo => !photo.containsPeople)).toBe(true);
    const selection = JSON.parse(await readFile(join(workspace, ".trip-output/selection.json"), "utf8")) as {
      rejected: Array<{ reason: string }>;
    };
    expect(selection.rejected.some(item => /people/i.test(item.reason))).toBe(true);
  });
});

// @verifies DES-PIPE-RUN, REQ-SEL-03, REQ-ING-03, ARCH-INGEST, SN-05, SN-07
describe("run decisions and unreadable files", () => {
  it("explains every photo and survives an unreadable file", async () => {
    await writeFile(join(input, "broken.jpg"), "not an image");
    const progress: string[] = [];
    try {
      await runTrip(options("Decisions"), {
        root: workspace,
        aiProvider: new FakeProvider(),
        inferDestinations: place,
        enrichDestination: enrich,
        onProgress: event => progress.push(event.message),
      });
    } finally {
      await import("node:fs/promises").then(fs => fs.unlink(join(input, "broken.jpg")));
    }
    expect(progress.some(message => message.startsWith("Skipped broken.jpg"))).toBe(true);
    const selection = JSON.parse(await readFile(join(workspace, ".trip-output/selection.json"), "utf8")) as {
      reasons: Record<string, string>;
    };
    const analysis = JSON.parse(await readFile(join(workspace, ".trip-output/photo-analysis.json"), "utf8")) as Array<{ id: string }>;
    expect(analysis.length).toBeGreaterThan(0);
    for (const photo of analysis) expect(selection.reasons[photo.id]).toBeTruthy();
  });
});

// @verifies DES-PIPE-RUN, ARCH-PIPELINE, REQ-LOC-02, REQ-LOC-03, SN-03
describe("location privacy modes", () => {
  const run = async (privacy: "hidden" | "broad" | "approximate" | "precise") => {
    await runTrip(options(`Mode ${privacy}`, { privacy }), {
      root: workspace,
      aiProvider: new FakeProvider(),
      inferDestinations: place,
      enrichDestination: enrich,
    });
    const manifest = await manifestOf(`mode-${privacy}`);
    return { manifest, text: JSON.stringify(manifest) };
  };

  it("hidden publishes no place, route, or coordinate", async () => {
    const { manifest, text } = await run("hidden");
    expect(manifest.destinations).toEqual([]);
    expect(manifest.route).toEqual([]);
    expect(text).not.toContain("Cannon Beach");
    expect(text).not.toContain("Haystack");
    expect(text).not.toContain("45.88");
  });

  it("broad publishes a region label and no coordinates", async () => {
    const { manifest, text } = await run("broad");
    expect(manifest.destinations.every(destination => destination.approximateCoordinate === undefined)).toBe(true);
    expect(text).not.toContain("45.88");
    expect(text).not.toContain("Haystack");
  });

  it("approximate rounds to one decimal and precise to two, never the raw reading", async () => {
    const approximate = await run("approximate"),
      precise = await run("precise");
    expect(approximate.manifest.destinations[0]!.approximateCoordinate).toEqual({ lat: 45.9, lon: -124 });
    expect(precise.manifest.destinations[0]!.approximateCoordinate).toEqual({ lat: 45.88, lon: -123.96 });
    for (const { text } of [approximate, precise]) {
      expect(text).not.toContain("45.88213");
      expect(text).not.toContain("-123.96221");
    }
  }, 30_000); // two full pipeline runs; the 5s default only holds on an idle machine
});

// @verifies DES-PIPE-RUN, ARCH-PLACE, REQ-LOC-01, REQ-LOC-04, REQ-AI-04, SN-06, SN-07
describe("offline sources", () => {
  it("still completes a photo-led page when every network source fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await runTrip(options("Offline Sources"), { root: workspace, aiProvider: new FakeProvider() });
    const manifest = await manifestOf("offline-sources");
    expect(manifest.photos.length).toBeGreaterThan(0);
    expect(manifest.sources).toEqual([]);
    expect(manifest.destinations.every(destination => destination.facts.length === 0)).toBe(true);
    expect(manifest.destinations.every(destination => !/Cannon Beach/.test(destination.name))).toBe(true);
  });

  it("generates the deterministic demo with no key and no photos", async () => {
    await mkdir(join(workspace, "data"), { recursive: true });
    await import("node:fs/promises").then(fs => fs.cp(join(process.cwd(), "data/trip.demo.json"), join(workspace, "data/trip.demo.json")));
    await import("node:fs/promises").then(fs =>
      fs.cp(join(process.cwd(), "public/trip/demo"), join(workspace, "public/trip/demo"), { recursive: true })
    );
    const result = await runTrip({ ...options("Demo"), demo: true, input: undefined }, { root: workspace });
    expect(result.summary).toBeDefined();
  });
});
