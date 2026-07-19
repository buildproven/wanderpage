import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AIProvider, Narrative } from "@/lib/ai/provider";
import type { DestinationEvidence } from "@/lib/location/infer";
import type { PhotoRecord } from "@/lib/photos/types";
import { runTrip } from "@/lib/pipeline/run";
import { validateStaticExport } from "@/lib/publishing/privacy";
import { TripManifestSchema } from "@/lib/schemas/trip";
import type { PhotoSemanticAnalysis } from "@/lib/schemas/analysis";
import { copySiteScaffold, createPhotoFolder, createTempWorkspace, removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);

describe("photo folder to deployed-site artifact", () => {
  let workspace = "",
    input = "";
  beforeAll(async () => {
    workspace = await createTempWorkspace("integration");
    await copySiteScaffold(workspace);
    input = await createPhotoFolder(workspace, { heic: true });
  }, 30_000);
  afterAll(async () => {
    if (workspace) await removeTempWorkspace(workspace);
  });

  it("ingests real image files, edits them, builds the static site, and opens it in a browser", async () => {
    const originalHashes = await fileHashes(input);
    const provider = new RecordingProvider();
    const result = await runTrip(
      {
        input,
        people: "exclude",
        title: "Controlled Coast Test",
        maxPhotos: 36,
        privacy: "approximate",
        force: true,
        dryRun: false,
        demo: false,
      },
      {
        root: workspace,
        aiProvider: provider,
        inferDestinations: fixtureDestinations,
        enrichDestination: async destination => ({
          introduction: `Verified fixture context for ${destination.name}.`,
          facts: [{ text: `Fixture fact for ${destination.name}.`, sourceId: `source-${destination.id}` }],
          sources: [
            {
              id: `source-${destination.id}`,
              title: `${destination.name} fixture source`,
              url: `https://example.test/${destination.id}`,
              provider: "Integration fixture",
            },
          ],
          weather: "10–16 °C",
        }),
      }
    );

    expect(result.summary.inputPhotos).toBe(process.platform === "darwin" ? 11 : 10);
    expect(result.summary.duplicatesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.summary.selectedPhotos).toBeGreaterThanOrEqual(2);
    expect(result.summary.destinationsFound).toBe(2);
    expect(provider.contactSheets).toHaveLength(1);
    expect(provider.contactSheets[0]!.bytes).toBeGreaterThan(10_000);
    expect(await fileHashes(input)).toEqual(originalHashes);

    expect(result.path).toBe("/trips/controlled-coast-test");
    const manifestPath = join(workspace, "data/trips/controlled-coast-test.json");
    const manifest = TripManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    expect(manifest.title).toBe("Controlled Coast Test");
    expect(manifest.peopleMode).toBe("exclude");
    expect(manifest.photos.every(photo => !photo.containsPeople)).toBe(true);
    expect(manifest.photos.every(photo => photo.srcLarge.startsWith("/trip/generated/"))).toBe(true);
    expect(manifest.route[0]).toMatchObject({ lat: 45.9, lon: -124 });

    await execute("pnpm", ["exec", "next", "build", workspace], {
      cwd: repoRoot,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", WANDERPAGE_WORKSPACE: workspace },
      maxBuffer: 10_000_000,
    });
    const exported = join(workspace, "out"),
      privacy = await validateStaticExport(exported, ["integration-secret-that-must-not-leak"]);
    expect(privacy.errors).toEqual([]);
    expect(await directoryBytes(exported)).toBeLessThan(90 * 1024 * 1024);
    await expectTextAbsent(exported, ["45.882", "-123.962", "Wanderpage Integration Camera"]);

    const server = await staticServer(exported),
      browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }),
        consoleErrors: string[] = [];
      page.on("console", message => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.goto(`${server.url}${result.path}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: "Controlled Coast Test" }).isVisible()).resolves.toBe(true);
      await expect(page.getByRole("heading", { name: /Made by Wanderpage/ }).count()).resolves.toBe(0);
      await expect(page.locator(".gallery-button").count()).resolves.toBe(manifest.photos.length);
      for (const button of await page.locator(".gallery-button").all()) await button.scrollIntoViewIfNeeded();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".gallery-button img")].every(
          image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        )
      );
      const loaded = await page
        .locator(".gallery-button img")
        .evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
      expect(loaded).toBe(true);
      await page.locator(".gallery-button").first().click();
      await expect(page.getByRole("dialog").isVisible()).resolves.toBe(true);
      expect(consoleErrors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120_000);

  it("runs the documented photo-folder CLI against an isolated workspace", async () => {
    const cliWorkspace = await createTempWorkspace("cli");
    try {
      await copySiteScaffold(cliWorkspace);
      const cliInput = await createPhotoFolder(cliWorkspace, { count: 4, gps: false });
      const originalHashes = await fileHashes(cliInput);
      await execute(
        "pnpm",
        [
          "exec",
          "tsx",
          join(repoRoot, "scripts/trip.ts"),
          "--input",
          cliInput,
          "--people",
          "include",
          "--title",
          "CLI Folder Test",
          "--max-photos",
          "12",
        ],
        { cwd: repoRoot, env: { ...process.env, OPENAI_API_KEY: "", WANDERPAGE_WORKSPACE: cliWorkspace }, maxBuffer: 10_000_000 }
      );
      expect(await fileHashes(cliInput)).toEqual(originalHashes);
      const manifest = TripManifestSchema.parse(JSON.parse(await readFile(join(cliWorkspace, "data/trips/cli-folder-test.json"), "utf8")));
      expect(manifest.title).toBe("CLI Folder Test");
      expect(manifest.photos.length).toBeGreaterThan(0);
      await execute("pnpm", ["exec", "next", "build", cliWorkspace], {
        cwd: repoRoot,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", WANDERPAGE_WORKSPACE: cliWorkspace },
        maxBuffer: 10_000_000,
      });
      const privacy = await validateStaticExport(join(cliWorkspace, "out"));
      expect(privacy.errors).toEqual([]);
    } finally {
      await removeTempWorkspace(cliWorkspace);
    }
  }, 120_000);
});

class RecordingProvider implements AIProvider {
  readonly contactSheets: Array<{ path: string; bytes: number }> = [];
  private photoIds: string[] = [];
  async analyzeContactSheet(path: string, photoIds: string[]): Promise<PhotoSemanticAnalysis[]> {
    this.contactSheets.push({ path, bytes: (await stat(path)).size });
    this.photoIds.push(...photoIds);
    return photoIds.map((photoId, index) => ({
      photoId,
      containsPeople: index === 0,
      peopleProminence: index === 0 ? "prominent" : "none",
      aestheticScore: 82 - index,
      storyScore: 78,
      landmarkValue: 70,
      emotionalValue: 45,
      uniquenessScore: 75 - index,
      categories: [index % 2 ? "detail" : "landscape"],
      possibleLocations: [{ label: "Oregon Coast", confidence: 0.7, evidence: "Coastal terrain in the fixture" }],
      captionSeed: `Visible fixture frame ${index + 1}.`,
    }));
  }
  async generateNarrative(): Promise<Narrative> {
    return {
      title: "Controlled Coast Test",
      subtitle: "A verified fixture route.",
      opening: "The controlled photographs follow two coastal groups.",
      closing: "The fixture route ends with the final selected frame.",
      chapterNarratives: [
        "A chapter assembled from controlled photo evidence.",
        "A second chapter assembled from controlled photo evidence.",
      ],
      captions: this.photoIds.map((photoId, index) => ({
        photoId,
        alt: `Controlled travel photograph ${index + 1}`,
        caption: `Controlled frame ${index + 1}.`,
      })),
    };
  }
}

async function fixtureDestinations(photos: PhotoRecord[]): Promise<DestinationEvidence[]> {
  const north = photos.filter(photo => (photo.gps?.lat ?? 0) > 45),
    south = photos.filter(photo => (photo.gps?.lat ?? 99) <= 45);
  return [
    {
      id: "destination-north",
      name: "North Coast Fixture",
      confidence: 0.96,
      lat: 45.882,
      lon: -123.962,
      photoIds: north.map(photo => photo.id),
      evidence: ["Controlled GPS cluster"],
    },
    {
      id: "destination-south",
      name: "South Coast Fixture",
      confidence: 0.94,
      lat: 44.642,
      lon: -124.062,
      photoIds: south.map(photo => photo.id),
      evidence: ["Controlled GPS cluster"],
    },
  ];
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

async function fileHashes(root: string, path = root): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await fileHashes(root, child));
    else
      hashes[relative(root, child)] = createHash("sha256")
        .update(await readFile(child))
        .digest("hex");
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

async function expectTextAbsent(path: string, values: string[]): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await expectTextAbsent(child, values);
    else if ([".html", ".js", ".json", ".txt", ".css", ".xml"].includes(extname(child))) {
      const text = await readFile(child, "utf8");
      for (const value of values) expect(text).not.toContain(value);
    }
  }
}

async function staticServer(root: string) {
  const server = createServer(async (request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname),
      relative = requested === "/" ? "index.html" : requested.replace(/^\/+|\/+$/g, "");
    const file = normalize(join(root, extname(relative) ? relative : `${relative}.html`));
    if (!file.startsWith(`${normalize(root)}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const metadata = await stat(file);
      if (!metadata.isFile()) throw new Error("Not a file");
      response.writeHead(200, { "Content-Type": mime(file) });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Static test server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

function mime(path: string) {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".png": "image/png",
        ".jpg": "image/jpeg",
      } as Record<string, string>
    )[extname(path)] ?? "application/octet-stream"
  );
}
