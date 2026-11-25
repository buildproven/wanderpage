import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { validateHostedManifestPolicy } from "@/lib/web/processor";
import { curationAttemptsPerDay, curationRevision, StoryService, type PhotoObjects } from "@/lib/web/story-service";
import type { LocationPrivacyMode, PeopleMode, Story } from "@/lib/web/types";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://trips.example.com",
  // Lisbon, to the metre: the tools may only ever report it rounded.
  exactLat = 38.7223,
  exactLon = -9.1393,
  gpsExif = {
    IFD2: { DateTimeOriginal: "2026:10:03 09:15:00" },
    IFD3: { GPSLatitudeRef: "N", GPSLatitude: "38/1 43/1 2028/100", GPSLongitudeRef: "W", GPSLongitude: "9/1 8/1 2148/100" },
  };

/** Objects in memory, keyed by pathname, standing in for Vercel Blob. */
class MemoryObjects implements PhotoObjects {
  readonly objects = new Map<string, Buffer>();
  async read(pathname: string) {
    const bytes = this.objects.get(pathname);
    if (!bytes) throw new Error(`missing object ${pathname}`);
    return bytes;
  }
  async write(pathname: string, bytes: Buffer) {
    this.objects.set(pathname, bytes);
  }
}

async function fixture(repository = new MemoryStoryRepository()) {
  const objects = new MemoryObjects(),
    policy = { enabled: true, ownerEnabled: true, dailyLimit: 25 },
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => policy,
      async () => undefined,
      objects
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner, publicOrigin: origin }),
    client = new Client({ name: "claude-curation-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { repository, objects, policy, stories, sessions, client };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function ownerStory(context: Fixture, peopleMode: PeopleMode, locationPrivacy: LocationPrivacyMode = "approximate") {
  return context.stories.createStory(await context.sessions.secretFor(owner), {
    title: "Lisbon by tram",
    peopleMode,
    locationPrivacy,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  });
}

/** A JPEG with a capture date and exact GPS. `noisy` photos do not compress, so their thumbnails are large. */
async function photo(index: number, noisy: boolean, exif = true) {
  if (!exif)
    return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 40, b: 10 } } })
      .png()
      .toBuffer();
  if (!noisy)
    return sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 20 * index, g: 90, b: 140 } } })
      .jpeg()
      .withExif(gpsExif)
      .toBuffer();
  const width = 1200,
    height = 900,
    pixels = Buffer.alloc(width * height * 3);
  let seed = 7919 * (index + 1);
  for (let offset = 0; offset < pixels.length; offset += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[offset] = seed >> 16;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .withExif(gpsExif)
    .toBuffer();
}

async function addPhotos(context: Fixture, story: Story, count: number, noisy = false, prefix = "00000000", exif = true) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      blobPath = `sources/${story.id}/${id}`;
    context.objects.objects.set(blobPath, await photo(index, noisy, exif));
    await context.repository.createUpload({
      id,
      storyId: story.id,
      blobPath,
      originalName: exif ? `${index}.jpg` : `${index}.png`,
      declaredType: exif ? "image/jpeg" : "image/png",
      status: "confirmed",
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)),
      confirmedAt: new Date(),
    });
    ids.push(id);
  }
  return ids;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    response,
    isError: response.isError === true,
    content: response.content as Content[],
    text: (response.content as Content[])[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

type PhotoInfo = { id: string; captureDate: string | null; place: { lat: number; lon: number } | null };

const curation = (ids: string[], extra: Record<string, unknown> = {}) => ({
  title: "Seven hills",
  intro: "A week of trams, tiles and river light.",
  photos: ids.map((id, index) => ({ id, caption: `Tiled facade number ${index + 1} in the morning sun.` })),
  ...extra,
});

// @verifies DES-WEB-MCP, DES-WEB-STORY, ARCH-WEB-STORY
describe("Claude curates hosted stories in chat (BUI-2205)", () => {
  // @verifies REQ-WEB-05
  it("BUI-2205 R1 (REQ-WEB-05): get_photos pages WebP thumbnails under 1 MB per result, with a cursor and no exact GPS", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 12, true),
      seen: PhotoInfo[] = [];
    let cursor: string | null | undefined,
      pages = 0;
    do {
      const result = await call(context.client, "get_photos", { storyId: story.id, ...(cursor ? { cursor } : {}) });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.response).length).toBeLessThan(1_000_000);
      const serialized = JSON.stringify(result.response);
      expect(serialized).not.toContain(String(exactLat).slice(0, 6));
      expect(serialized).not.toContain(String(exactLon).slice(0, 6));
      const page = result.data as { photos: PhotoInfo[]; nextCursor: string | null },
        images = result.content.filter(item => item.type === "image");
      expect(images).toHaveLength(page.photos.length);
      expect(page.photos.length).toBeGreaterThan(0);
      for (const image of images) {
        expect(image.mimeType).toBe("image/webp");
        const metadata = await sharp(Buffer.from(image.data ?? "", "base64")).metadata();
        expect(metadata.format).toBe("webp");
        expect(metadata.exif).toBeUndefined();
        expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(512);
      }
      seen.push(...page.photos);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 12);
    expect(pages).toBeGreaterThan(1);
    expect(seen.map(item => item.id)).toEqual(ids);
    for (const item of seen) {
      expect(item.captureDate).toBe("2026-10-03");
      expect(item.place).toEqual({ lat: 38.7, lon: -9.1 });
    }
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R1 (REQ-WEB-05): get_photos reports no place for a hidden-location story and refuses a story that is not uploading", async () => {
    const context = await fixture(),
      hidden = await ownerStory(context, "include", "hidden");
    await addPhotos(context, hidden, 2);
    const result = await call(context.client, "get_photos", { storyId: hidden.id });
    expect(result.isError).toBe(false);
    expect((result.data as { photos: PhotoInfo[] }).photos.map(item => item.place)).toEqual([null, null]);
    expect((result.data as { nextCursor: string | null }).nextCursor).toBeNull();
    await context.repository.saveStory({ ...hidden, status: "queued" }, hidden.version);
    const refused = await call(context.client, "get_photos", { storyId: hidden.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/get_photos refused/);
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): save_curation saves the chosen photos in order with Claude's text as the private draft", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6),
      chosen = [ids[4]!, ids[0]!, ids[2]!],
      result = await call(context.client, "save_curation", {
        storyId: story.id,
        ...curation(chosen, { closing: "The last tram home." }),
      });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ id: story.id, status: "draft", photoCount: 3 });
    const saved = (await context.repository.findStory(story.id))!,
      manifest = saved.manifest!;
    expect(saved.status).toBe("draft");
    expect(manifest.title).toBe("Seven hills");
    expect(saved.title).toBe("Seven hills");
    expect(manifest.opening).toBe("A week of trams, tiles and river light.");
    expect(manifest.closing).toBe("The last tram home.");
    expect(manifest.photos.map(item => item.id)).toEqual(chosen);
    expect(manifest.heroPhotoId).toBe(chosen[0]);
    expect(manifest.photos[1]?.caption).toBe("Tiled facade number 2 in the morning sun.");
    expect(manifest.chapters.flatMap(chapter => chapter.photoIds)).toEqual(chosen);
    expect(manifest.destinations).toEqual([]);
    expect(manifest.route).toEqual([]);
    expect(validateHostedManifestPolicy(manifest, saved.locationPrivacy)).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain("38.72");
    for (const item of manifest.photos)
      for (const path of [item.srcLarge, item.srcMedium, item.srcThumb]) {
        expect(path.startsWith(`/api/media/${story.id}/`)).toBe(true);
        const [revision, runId, name] = decodeURIComponent(path.split("/").at(-1)!).split("--"),
          bytes = context.objects.objects.get(`derivatives/${story.id}/${revision}/${runId}/${name}`);
        expect(bytes).toBeDefined();
        const metadata = await sharp(bytes!).metadata();
        expect(metadata.format).toBe("webp");
        expect(metadata.exif).toBeUndefined();
      }
    const runs = await context.repository.listRuns(story.id);
    expect(runs.map(run => run.status)).toEqual(["complete"]);
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): save_curation rejects a photo id that is not in the story, and leaves the story unchanged", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6),
      other = await ownerStory(context, "include"),
      [foreignId] = await addPhotos(context, other, 1, false, "11111111");
    for (const unknown of ["22222222-2222-4222-8222-222222222222", foreignId!]) {
      const result = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!, unknown]) });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(unknown);
    }
    const repeated = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!, ids[0]!]) });
    expect(repeated.isError).toBe(true);
    const unchanged = (await context.repository.findStory(story.id))!;
    expect(unchanged.status).toBe("uploading");
    expect(unchanged.manifest).toBeUndefined();
    expect(await context.repository.listRuns(story.id)).toEqual([]);
    expect([...context.objects.objects.keys()].some(key => key.startsWith("derivatives/"))).toBe(false);
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): save_curation rejects text that names or identifies a person, or gives coordinates", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6);
    const attempts = [
      { title: "Lisbon with my wife Anna" },
      { intro: "Mr. Silva showed us the old town." },
      { intro: "Our guide @lisbon_walks knew every alley." },
      { intro: "We stood at 38.7223, -9.1393 at dawn." },
      { photos: [{ id: ids[0], caption: "My daughter at the viewpoint." }] },
    ];
    for (const attempt of attempts) {
      const result = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!]), ...attempt });
      expect(result.isError, JSON.stringify(attempt)).toBe(true);
    }
    expect((await context.repository.findStory(story.id))!.status).toBe("uploading");
  });

  // @verifies REQ-SEL-02
  it("BUI-2205 R3 (REQ-SEL-02): in an exclude-people story, save_curation rejects containsPeople true or missing, and stores only sent values", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "exclude"),
      ids = await addPhotos(context, story, 6),
      base = curation([ids[0]!, ids[1]!]);
    const withPeople = await call(context.client, "save_curation", {
      storyId: story.id,
      ...base,
      photos: [
        { ...base.photos[0], containsPeople: false },
        { ...base.photos[1], containsPeople: true },
      ],
    });
    expect(withPeople.isError).toBe(true);
    expect(withPeople.text).toContain(ids[1]);
    const missing = await call(context.client, "save_curation", {
      storyId: story.id,
      ...base,
      photos: [{ ...base.photos[0], containsPeople: false }, base.photos[1]],
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(ids[1]);
    expect((await context.repository.findStory(story.id))!.manifest).toBeUndefined();
    const accepted = await call(context.client, "save_curation", {
      storyId: story.id,
      ...base,
      photos: base.photos.map(item => ({ ...item, containsPeople: false })),
    });
    expect(accepted.isError).toBe(false);
    const manifest = (await context.repository.findStory(story.id))!.manifest!;
    expect(manifest.peopleMode).toBe("exclude");
    expect(manifest.photos.map(item => item.containsPeople)).toEqual([false, false]);
  });

  // @verifies REQ-SEL-02
  it("BUI-2205 R3 (REQ-SEL-02): an include-people story never stores containsPeople false that Claude did not send", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6),
      base = curation([ids[0]!, ids[1]!]),
      result = await call(context.client, "save_curation", {
        storyId: story.id,
        ...base,
        photos: [{ ...base.photos[0], containsPeople: false }, base.photos[1]],
      });
    expect(result.isError).toBe(false);
    const manifest = (await context.repository.findStory(story.id))!.manifest!;
    expect(manifest.photos.map(item => item.containsPeople)).toEqual([false, true]);
  });

  // @verifies REQ-AGENT-1
  it("BUI-2205 R4 (REQ-AGENT-1): the skill makes a hosted page by calling get_photos, writing the text itself, then save_curation", () => {
    const skill = readFileSync("skills/wanderpage/SKILL.md", "utf8"),
      hosted = skill.slice(skill.indexOf("## Hosted stories"));
    expect(hosted.indexOf("get_photos")).toBeGreaterThan(-1);
    expect(hosted.indexOf("save_curation")).toBeGreaterThan(hosted.indexOf("get_photos"));
    expect(hosted.replace(/\s+/g, " ")).toMatch(/write the captions/i);
    expect(skill.split("---")[1]).toMatch(/get_photos/);
    expect(skill.split("---")[1]).toMatch(/save_curation/);
  });
  // @verifies REQ-WEB-05
  it("BUI-2205 R1 (REQ-WEB-05): get_photos rounds a broad story to whole degrees, reports nothing a photo lacks, and refuses a bad cursor", async () => {
    const context = await fixture(),
      broad = await ownerStory(context, "include", "broad");
    await addPhotos(context, broad, 1);
    await addPhotos(context, broad, 1, false, "33333333", false);
    const result = await call(context.client, "get_photos", { storyId: broad.id }),
      photos = (result.data as { photos: PhotoInfo[] }).photos;
    expect(photos.map(item => item.place)).toEqual([{ lat: 39, lon: -9 }, null]);
    expect(photos.map(item => item.captureDate)).toEqual(["2026-10-03", null]);
    const past = await call(context.client, "get_photos", { storyId: broad.id, cursor: "999" });
    expect(past.isError).toBe(true);
    expect(past.text).toMatch(/cursor/);
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R1 (REQ-WEB-05): get_photos and save_curation refuse expired sources, another session's story, and a closed owner switch", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6),
      stranger = (
        await context.stories.createSessionWithStory(
          {
            title: "Someone else's trip",
            peopleMode: "include",
            locationPrivacy: "approximate",
            termsVersion: currentDisclosureVersion,
            uploadConsentVersion: currentDisclosureVersion,
          },
          "client"
        )
      ).story;
    for (const tool of ["get_photos", "save_curation"]) {
      const args = tool === "get_photos" ? { storyId: stranger.id } : { storyId: stranger.id, ...curation([ids[0]!]) },
        result = await call(context.client, tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`${tool} refused: this story belongs to another private session`);
    }
    context.policy.enabled = false;
    context.policy.ownerEnabled = false;
    const closed = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!]) });
    expect(closed.isError).toBe(true);
    expect(closed.text).toMatch(/temporarily unavailable/);
    context.policy.enabled = true;
    await context.repository.saveStory({ ...story, sourceExpiresAt: new Date(Date.now() - 1000) }, story.version);
    const expiredCalls: Array<[string, Record<string, unknown>]> = [
      ["get_photos", { storyId: story.id }],
      ["save_curation", { storyId: story.id, ...curation([ids[0]!]) }],
    ];
    for (const [tool, args] of expiredCalls) {
      const result = await call(context.client, tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/expired/);
    }
    expect((await context.repository.findStory(story.id))!.status).toBe("uploading");
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): a failed derivative write marks the run failed for cleanup and leaves the story uploading", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6);
    context.objects.write = async () => {
      throw new Error("blob store is down");
    };
    const result = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!, ids[1]!]) });
    expect(result.isError).toBe(true);
    const saved = (await context.repository.findStory(story.id))!;
    expect([saved.status, saved.activeRunId, saved.manifest]).toEqual(["uploading", undefined, undefined]);
    const runs = await context.repository.listRuns(story.id);
    expect(runs.map(run => [run.status, run.errorCode])).toEqual([["failed", "CURATION_FAILED"]]);
    expect((await context.repository.listRunsForDerivativeCleanup(10)).map(run => run.id)).toEqual(runs.map(run => run.id));
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): when the draft cannot be completed, save_curation restores the story to its earlier status", async () => {
    class FailingCompletion extends MemoryStoryRepository {
      override async completeRun(): Promise<void> {
        throw new Error("RUN_STATE_CONFLICT");
      }
    }
    const context = await fixture(new FailingCompletion()),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6);
    await context.repository.saveStory({ ...story, status: "failed" }, story.version);
    const result = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!]) });
    expect(result.isError).toBe(true);
    const saved = (await context.repository.findStory(story.id))!;
    expect([saved.status, saved.activeRunId, saved.manifest]).toEqual(["failed", undefined, undefined]);
    expect((await context.repository.listRuns(story.id)).map(run => run.status)).toEqual(["failed"]);
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): save_curation accepts plain scene text and rejects a relationship word with an accent", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6),
      accented = await call(context.client, "save_curation", {
        storyId: story.id,
        ...curation([ids[0]!]),
        intro: "A week away with my fiancée.",
      });
    expect(accented.isError).toBe(true);
    const plain = await call(context.client, "save_curation", {
      storyId: story.id,
      ...curation([ids[0]!]),
      intro: "Miradouro views at 7:30, pastries for 1.50 each, and trams to the castle.",
    });
    expect(plain.isError).toBe(false);
  });
  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): save_curation rejects a bare given name, and keeps place names that contain one", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6);
    for (const caption of [
      "John at the beach.",
      "Maria and Tom on the ferry.",
      "Jean-Pierre waves from the deck.",
      "Sarah's favourite café.",
    ]) {
      const result = await call(context.client, "save_curation", {
        storyId: story.id,
        ...curation([ids[0]!]),
        photos: [{ id: ids[0], caption }],
      });
      expect(result.isError, caption).toBe(true);
      expect(result.text).toMatch(/names a person/);
    }
    const places = await call(context.client, "save_curation", {
      storyId: story.id,
      ...curation([ids[0]!, ids[1]!, ids[2]!]),
      intro: "From San Diego to St. Mary's Church, then Lake George and Saint-Louis.",
      photos: [
        { id: ids[0], caption: "Charles Bridge at dawn." },
        { id: ids[1], caption: "Santa Maria Maggiore from the steps." },
        { id: ids[2], caption: "Rose light over the river in May." },
      ],
    });
    expect(places.isError, places.text).toBe(false);
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R1 (REQ-WEB-05): get_photos takes a null cursor as the first page, and save_curation names a malformed photo id", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 2),
      first = await call(context.client, "get_photos", { storyId: story.id, cursor: null });
    expect(first.isError).toBe(false);
    expect((first.data as { photos: PhotoInfo[] }).photos.map(item => item.id)).toEqual(ids);
    const malformed = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!, "not-a-photo"]) });
    expect(malformed.isError).toBe(true);
    expect(malformed.text).toContain("not-a-photo");
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): save_curation builds the page from six 12-megapixel photos well inside the test timeout", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6),
      large = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 120, g: 80, b: 40 } } })
        .jpeg()
        .withExif(gpsExif)
        .toBuffer();
    for (const upload of await context.repository.listUploads(story.id)) context.objects.objects.set(upload.blobPath, large);
    const started = performance.now(),
      result = await call(context.client, "save_curation", { storyId: story.id, ...curation(ids) });
    expect(result.isError, result.text).toBe(false);
    expect(performance.now() - started).toBeLessThan(2500);
    const manifest = (await context.repository.findStory(story.id))!.manifest!;
    expect(manifest.photos.map(item => [item.width, item.height])).toEqual(ids.map(() => [1800, 1350]));
  });
  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05, REQ-LOC-03): a hidden or broad story keeps Claude's photos and order but withholds Claude's text", async () => {
    const context = await fixture();
    for (const privacy of ["hidden", "broad"] as const) {
      const story = await ownerStory(context, "include", privacy),
        ids = await addPhotos(context, story, 6, false, privacy === "hidden" ? "44444444" : "55555555"),
        chosen = [ids[3]!, ids[1]!],
        result = await call(context.client, "save_curation", {
          storyId: story.id,
          title: "Rua Augusta mornings",
          intro: "Trams climbing from Baixa to Alfama.",
          closing: "Sunset over the Tagus.",
          photos: chosen.map(id => ({ id, caption: "Rua Augusta arch at dawn." })),
        });
      expect(result.isError, result.text).toBe(false);
      expect(result.data).toMatchObject({ status: "draft", textWithheld: true, title: "Lisbon by tram" });
      const saved = (await context.repository.findStory(story.id))!,
        manifest = saved.manifest!,
        serialized = JSON.stringify(manifest);
      expect(saved.title).toBe("Lisbon by tram");
      expect(manifest.title).toBe("Lisbon by tram");
      expect(manifest.photos.map(item => item.id)).toEqual(chosen);
      expect(manifest.photos.map(item => item.caption)).toEqual([undefined, undefined]);
      for (const text of ["Rua Augusta", "Baixa", "Alfama", "Tagus"]) expect(serialized, `${privacy}: ${text}`).not.toContain(text);
      expect(validateHostedManifestPolicy(manifest, privacy)).toEqual([]);
    }
    const approximate = await ownerStory(context, "include"),
      [first] = await addPhotos(context, approximate, 6, false, "66666666"),
      kept = await call(context.client, "save_curation", { storyId: approximate.id, ...curation([first!]) });
    expect(kept.data).toMatchObject({ textWithheld: false, title: "Seven hills" });
  });

  // @verifies REQ-WEB-05
  it("BUI-2205 R2 (REQ-WEB-05): curation runs carry their own revision and a per-story daily attempt limit", async () => {
    const context = await fixture(),
      story = await ownerStory(context, "include"),
      ids = await addPhotos(context, story, 6),
      now = new Date(),
      run = (id: string, processorRevision: string, admittedAt = now) => ({
        id,
        storyId: story.id,
        processorRevision,
        admittedAt,
        status: "failed" as const,
        stage: "curating",
        progress: 0,
        attempts: 1,
        sourceUploadIds: [],
        updatedAt: now,
      });
    // Generation runs and curation attempts older than a day do not count toward the curation limit.
    await context.repository.createRun(run("77777777-0000-4000-8000-000000000000", "web-v1"));
    await context.repository.createRun(
      run("77777777-0000-4000-8000-000000000001", curationRevision, new Date(now.getTime() - 25 * 60 * 60 * 1000))
    );
    for (let index = 0; index < curationAttemptsPerDay - 1; index += 1)
      await context.repository.createRun(run(`88888888-0000-4000-8000-00000000000${index}`, curationRevision));
    const saved = await call(context.client, "save_curation", { storyId: story.id, ...curation([ids[0]!]) });
    expect(saved.isError, saved.text).toBe(false);
    const curated = (await context.repository.listRuns(story.id)).filter(item => item.status === "complete");
    expect(curated.map(item => item.processorRevision)).toEqual([curationRevision]);
    const manifest = (await context.repository.findStory(story.id))!.manifest!;
    expect(manifest.photos[0]!.srcLarge).toContain(`/${curationRevision}--`);

    const limited = await ownerStory(context, "include"),
      [photoId] = await addPhotos(context, limited, 6, false, "99999999");
    for (let index = 0; index < curationAttemptsPerDay; index += 1)
      await context.repository.createRun({ ...run(`aaaaaaaa-0000-4000-8000-00000000000${index}`, curationRevision), storyId: limited.id });
    const refused = await call(context.client, "save_curation", { storyId: limited.id, ...curation([photoId!]) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/curation attempts/);
    expect((await context.repository.findStory(limited.id))!.status).toBe("uploading");
  });
});
