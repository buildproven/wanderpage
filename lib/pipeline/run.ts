import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { buildContactSheet } from "@/lib/ai/contact-sheet";
import { MockAIProvider, OpenAIProvider, type AIProvider } from "@/lib/ai/provider";
import { enrichDestination } from "@/lib/enrichment/providers";
import { inferDestinations, roundedCoordinate } from "@/lib/location/infer";
import { groupDuplicates } from "@/lib/photos/duplicates";
import { discoverPhotos, ingestPhotos } from "@/lib/photos/ingest";
import { publishPhoto } from "@/lib/publishing/images";
import { writeReports } from "@/lib/publishing/report";
import { selectPhotos } from "@/lib/selection/select";
import { TripManifestSchema, type TripManifest } from "@/lib/schemas/trip";
import { availableTripSlug } from "@/lib/trips/slug";

export type RunOptions = {
  input?: string;
  people: "include" | "exclude";
  title?: string;
  maxPhotos: number;
  privacy: "approximate" | "exact";
  force: boolean;
  dryRun: boolean;
  demo: boolean;
};
export type PipelineProgress = {
  stage: "discover" | "ingest" | "analyze" | "locate" | "select" | "write" | "enrich" | "publish" | "report" | "complete";
  progress: number;
  message: string;
};
export type RunDependencies = {
  root?: string;
  aiProvider?: AIProvider;
  inferDestinations?: typeof inferDestinations;
  enrichDestination?: typeof enrichDestination;
  onProgress?: (event: PipelineProgress) => void;
};

export async function runTrip(options: RunOptions, dependencies: RunDependencies = {}) {
  const root = resolve(dependencies.root ?? process.env.WANDERPAGE_WORKSPACE ?? process.cwd());
  const cache = join(root, ".trip-cache"),
    output = join(root, ".trip-output"),
    generated = join(root, "public/trip/generated");
  if (options.demo) return runDemo(root, output);
  if (!options.input) throw new Error("--input is required unless --demo is used");
  if (options.people === "exclude" && !process.env.OPENAI_API_KEY && !dependencies.aiProvider)
    throw new Error(
      "OPENAI_API_KEY is required for strict --people exclude filtering. Use pnpm trip:demo to run the deterministic mock pipeline."
    );
  const input = resolve(options.input),
    files = await discoverPhotos(input);
  if (!files.length) throw new Error("No supported JPEG, PNG, WebP, HEIC, or HEIF photos were found");
  dependencies.onProgress?.({ stage: "discover", progress: 6, message: `Found ${files.length} supported photos` });
  console.log(`\nWanderpage · ${files.length} photos found`);
  let ingested = 0;
  const photos = groupDuplicates(
    await ingestPhotos(
      files,
      cache,
      message => {
        ingested++;
        console.log(`  ${message}`);
        dependencies.onProgress?.({ stage: "ingest", progress: 8 + Math.round((ingested / files.length) * 24), message });
      },
      options.force
    )
  );
  const provider = dependencies.aiProvider ?? (process.env.OPENAI_API_KEY ? new OpenAIProvider() : new MockAIProvider());
  let apiCalls = 0;
  const candidates = photos.filter(photo => photo.rejectionReasons.length === 0 && !photo.duplicateOf);
  for (let offset = 0; offset < candidates.length; offset += 16) {
    const sheetPhotos = candidates.slice(offset, offset + 16),
      sheetNumber = Math.floor(offset / 16) + 1,
      totalSheets = Math.ceil(candidates.length / 16),
      sheet = join(output, "contact-sheets", `sheet-${sheetNumber}.jpg`),
      cacheKey = createHash("sha256")
        .update(`vision-v1:${process.env.OPENAI_VISION_MODEL ?? "mock"}:${sheetPhotos.map(p => p.hash).join(":")}`)
        .digest("hex"),
      analysisCache = join(cache, `${cacheKey}-vision.json`);
    dependencies.onProgress?.({
      stage: "analyze",
      progress: 34 + Math.round((sheetNumber / Math.max(1, totalSheets)) * 22),
      message: `Analyzing contact sheet ${sheetNumber} of ${totalSheets}`,
    });
    let analysis = options.force
      ? undefined
      : await readFile(analysisCache, "utf8")
          .then(value => JSON.parse(value) as Awaited<ReturnType<AIProvider["analyzeContactSheet"]>>)
          .catch(() => undefined);
    if (!analysis) {
      await buildContactSheet(sheetPhotos, sheet);
      analysis = await provider.analyzeContactSheet(
        sheet,
        sheetPhotos.map(p => p.id)
      );
      await writeFile(analysisCache, JSON.stringify(analysis));
      apiCalls++;
    }
    for (const item of analysis) {
      const photo = photos.find(p => p.id === item.photoId);
      if (photo) photo.semantic = item;
    }
  }
  const destinationInference = dependencies.inferDestinations ?? inferDestinations;
  const destinationEnrichment = dependencies.enrichDestination ?? enrichDestination;
  dependencies.onProgress?.({ stage: "locate", progress: 60, message: "Inferring the route from available evidence" });
  const destinations = await destinationInference(
    photos,
    process.env.WIKIMEDIA_USER_AGENT ?? "Wanderpage/0.1 (personal vacation story generator)"
  );
  dependencies.onProgress?.({ stage: "select", progress: 68, message: "Selecting the strongest, most varied photographs" });
  const selection = selectPhotos(photos, options.people, options.maxPhotos);
  dependencies.onProgress?.({ stage: "write", progress: 74, message: "Writing the story from supported evidence" });
  const narrative = await provider.generateNarrative(
    JSON.stringify({
      title: options.title,
      peopleMode: options.people,
      photos: selection.selected.map(p => ({
        id: p.id,
        captureTime: p.captureTime,
        categories: p.semantic?.categories,
        captionSeed: p.semantic?.captionSeed,
        locationClues: p.semantic?.possibleLocations,
      })),
      destinations: destinations.map(d => ({
        name: d.confidence >= 0.55 ? d.name : undefined,
        confidence: d.confidence,
        evidence: d.evidence,
      })),
    })
  );
  apiCalls++;
  dependencies.onProgress?.({ stage: "enrich", progress: 80, message: "Adding sourced destination context" });
  const enriched = await Promise.all(
    destinations.map(destination =>
      destinationEnrichment(
        destination,
        process.env.WIKIMEDIA_USER_AGENT ?? "Wanderpage/0.1 (personal vacation story generator)",
        selection.selected.find(p => destination.photoIds.includes(p.id))?.captureTime?.slice(0, 10)
      )
    )
  );
  dependencies.onProgress?.({ stage: "publish", progress: 86, message: "Preparing private, metadata-free web images" });
  const manifest = await makeManifest(options, selection, narrative, destinations, enriched, generated);
  const summary = {
    generatedAt: new Date().toISOString(),
    inputPhotos: files.length,
    readablePhotos: photos.length,
    duplicatesRemoved: photos.filter(p => p.duplicateOf).length,
    lowQualityRejected: photos.filter(p => p.rejectionReasons.length && !p.duplicateOf).length,
    selectedPhotos: selection.selected.length,
    destinationsFound: destinations.filter(d => d.confidence >= 0.55).length,
    modelCalls: apiCalls,
    analysisImages: candidates.length,
    provider: dependencies.aiProvider ? "injected-test-provider" : process.env.OPENAI_API_KEY ? "openai" : "deterministic-mock",
  };
  dependencies.onProgress?.({ stage: "report", progress: 94, message: "Writing the local review report" });
  await writeReports(output, photos, selection, destinations, summary);
  const tripsDirectory = join(root, "data/trips");
  await mkdir(tripsDirectory, { recursive: true });
  const slug = await availableTripSlug(tripsDirectory, manifest),
    path = `/trips/${slug}`;
  if (!options.dryRun) await writeFile(join(tripsDirectory, `${slug}.json`), JSON.stringify(TripManifestSchema.parse(manifest), null, 2));
  dependencies.onProgress?.({ stage: "complete", progress: 100, message: "Trip page generation complete" });
  console.log(
    `\nWanderpage complete\n\nInput photos:         ${files.length}\nDuplicates removed:   ${summary.duplicatesRemoved}\nLow-quality rejected: ${summary.lowQualityRejected}\nSelected photos:      ${selection.selected.length}\nDestinations found:   ${summary.destinationsFound}\nPage:                  ${path}\nReport:                .trip-output/report/index.html`
  );
  return { manifest, summary, slug, path };
}

async function makeManifest(
  options: RunOptions,
  selection: ReturnType<typeof selectPhotos>,
  narrative: Awaited<ReturnType<AIProvider["generateNarrative"]>>,
  destinations: Awaited<ReturnType<typeof inferDestinations>>,
  enriched: Awaited<ReturnType<typeof enrichDestination>>[],
  generated: string
): Promise<TripManifest> {
  await mkdir(generated, { recursive: true });
  const published = await Promise.all(selection.selected.map(photo => publishPhoto(photo, generated)));
  const captions = new Map(narrative.captions.map(item => [item.photoId, item]));
  const destinationObjects = destinations
    .filter(d => d.confidence >= 0.55)
    .map((destination, index) => ({
      id: destination.id,
      name: destination.confidence >= 0.8 ? destination.name : broaden(destination.name),
      confidence: destination.confidence,
      approximateCoordinate: {
        lat: roundedCoordinate(destination.lat, options.privacy),
        lon: roundedCoordinate(destination.lon, options.privacy),
      },
      introduction: enriched[index]?.introduction ?? "",
      facts: enriched[index]?.facts ?? [],
    }));
  const chapterGroups = new Map<string, typeof selection.selected>();
  for (const photo of selection.selected) {
    const destination = destinations.find(d => d.photoIds.includes(photo.id) && d.confidence >= 0.55);
    const key = destination?.id ?? photo.captureTime?.slice(0, 10) ?? "story";
    chapterGroups.set(key, [...(chapterGroups.get(key) ?? []), photo]);
  }
  const chapters = [...chapterGroups.entries()].map(([key, items], index) => {
    const destination = destinationObjects.find(d => d.id === key);
    return {
      id: `chapter-${index + 1}`,
      title: destination?.name ?? (items[0]?.captureTime ? `Day of ${items[0].captureTime.slice(0, 10)}` : `Chapter ${index + 1}`),
      destinationId: destination?.id,
      date: items[0]?.captureTime?.slice(0, 10),
      narrative:
        narrative.chapterNarratives[index] ??
        narrative.chapterNarratives[0] ??
        "A sequence ordered from the available photographic evidence.",
      photoIds: items.map(p => p.id),
      layout: ["split", "editorial", "mosaic", "filmstrip"][index % 4] as "split" | "editorial" | "mosaic" | "filmstrip",
    };
  });
  const captures = selection.selected
    .map(p => p.captureTime)
    .filter((v): v is string => Boolean(v))
    .sort();
  const distance = routeDistance(destinations);
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    published: true,
    title: options.title ?? narrative.title,
    subtitle: narrative.subtitle,
    opening: narrative.opening,
    closing: narrative.closing,
    dateRange: captures.length ? { start: captures[0]!.slice(0, 10), end: captures.at(-1)!.slice(0, 10) } : undefined,
    peopleMode: options.people,
    theme: { background: "#f2eee5", foreground: "#17211f", accent: "#c76542", muted: "#a4aca5" },
    heroPhotoId: selection.heroId,
    stats: [
      { label: "Days", value: String(new Set(captures.map(d => d.slice(0, 10))).size || 1) },
      { label: "Destinations", value: String(destinationObjects.length) },
      { label: "Approx. distance", value: distance ? `${Math.round(distance)} km` : "—" },
      { label: "Selected frames", value: String(selection.selected.length) },
    ],
    destinations: destinationObjects,
    route: destinationObjects.map((d, index) => ({
      destinationId: d.id,
      sequence: index + 1,
      lat: d.approximateCoordinate.lat,
      lon: d.approximateCoordinate.lon,
    })),
    chapters,
    photos: selection.selected.map(photo => {
      const asset = published.find(p => p.id === photo.id)!;
      const text = captions.get(photo.id);
      const destination = destinations.find(d => d.photoIds.includes(photo.id) && d.confidence >= 0.55);
      return {
        ...asset,
        alt: text?.alt ?? "A selected photograph from the trip",
        caption: text?.caption ?? photo.semantic?.captionSeed,
        captureTime: photo.captureTime,
        destinationId: destination?.id,
        containsPeople: photo.semantic?.containsPeople ?? false,
        source: "user" as const,
      };
    }),
    sources: enriched.flatMap(item => item.sources),
  };
}
function broaden(name: string) {
  const parts = name.split(",");
  return parts.at(-1)?.trim() || "the surrounding region";
}
function routeDistance(destinations: Awaited<ReturnType<typeof inferDestinations>>) {
  let total = 0;
  for (let i = 1; i < destinations.length; i++) {
    const a = destinations[i - 1]!,
      b = destinations[i]!;
    const p = Math.PI / 180,
      dLat = (b.lat - a.lat) * p,
      dLon = (b.lon - a.lon) * p,
      s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
    total += 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  return total;
}
async function runDemo(root: string, output: string) {
  await mkdir(output, { recursive: true });
  const demo = TripManifestSchema.parse(JSON.parse(await readFile(join(root, "data/trip.demo.json"), "utf8")));
  const publishedAssets = new Set(demo.photos.flatMap(photo => [photo.srcLarge, photo.srcMedium, photo.srcThumb])),
    publishedSizeBytes = (
      await Promise.all(
        [...publishedAssets].map(async src => {
          try {
            return (await stat(join(root, "public", src.replace(/^\//, "")))).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              throw new Error(`Demo manifest references a missing published asset: ${src}`, { cause: error });
            throw error;
          }
        })
      )
    ).reduce((total, bytes) => total + bytes, 0),
    publishedSizeLabel =
      publishedSizeBytes < 1024 * 1024
        ? `${Math.ceil(publishedSizeBytes / 1024)} KB`
        : `${(publishedSizeBytes / (1024 * 1024)).toFixed(1)} MB`,
    selectedPhotos = demo.photos.filter(photo => photo.source === "user").length,
    destinationsFound = demo.destinations.length;
  const summary = {
    generatedAt: new Date().toISOString(),
    inputPhotos: demo.photos.length,
    duplicatesRemoved: 0,
    lowQualityRejected: 0,
    selectedPhotos,
    destinationsFound,
    modelCalls: 0,
    provider: "deterministic-mock",
    publishedSizeBytes,
  };
  await mkdir(join(output, "report"), { recursive: true });
  await cp(join(root, "data/trip.demo.json"), join(output, "selection.json"));
  await writeFile(
    join(output, "photo-analysis.json"),
    JSON.stringify({ mode: "demo", photos: demo.photos.map(p => ({ id: p.id, containsPeople: p.containsPeople })) }, null, 2)
  );
  await writeFile(join(output, "location-analysis.json"), JSON.stringify(demo.destinations, null, 2));
  await writeFile(join(output, "run-summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(
    join(output, "report/index.html"),
    `<!doctype html><title>Wanderpage demo report</title><style>body{font:16px system-ui;max-width:760px;margin:4rem auto;color:#17211f}</style><h1>Deterministic demo complete</h1><p>${selectedPhotos} curated demo frames, ${destinationsFound} approximate destinations, no people, no API calls.</p><p>The public story contains optimized metadata-free WebP assets only.</p>`
  );
  console.log(
    `\nWanderpage demo complete\n\nSelected photos:      ${selectedPhotos}\nDestinations found:   ${destinationsFound}\nPublished size:       ${publishedSizeLabel}\nPage:                  /demo\nLocal preview:        pnpm build && pnpm preview\nReport:               .trip-output/report/index.html`
  );
  return { manifest: demo, summary, slug: "demo", path: "/demo" };
}
