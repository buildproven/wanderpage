import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService, type StoryObjects } from "@/lib/web/story-service";
import type { LocationPrivacyMode, Story } from "@/lib/web/types";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://trips.example.com",
  // The exact GPS written into every test photo; no tool result may carry it.
  exactLat = 45.88123,
  exactLon = -123.96789;

/** Object storage in memory, standing in for Vercel Blob. */
function memoryObjects() {
  const objects = new Map<string, Buffer>(),
    failing = new Set<string>(),
    store: StoryObjects = {
      read: async pathname => {
        const bytes = objects.get(pathname);
        if (!bytes || failing.has(pathname)) throw new Error(`Private object ${pathname} is unavailable.`);
        return bytes;
      },
      write: async (pathname, bytes) => {
        objects.set(pathname, bytes);
      },
      remove: async pathnames => {
        for (const pathname of pathnames) objects.delete(pathname);
      },
    };
  return { objects, failing, store };
}

async function fixture(locationPrivacy: LocationPrivacyMode = "approximate") {
  const repository = new MemoryStoryRepository(),
    media = memoryObjects(),
    policy = { enabled: true, dailyLimit: 25 },
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow-1" }) },
      undefined,
      value => `hash:${value}`,
      () => policy,
      async () => undefined,
      media.store
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
  const story = await stories.createStory(await sessions.secretFor(owner), {
    title: "Oregon coast",
    peopleMode: "exclude",
    locationPrivacy,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  });
  return { repository, media, stories, sessions, client, story, policy };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A busy 2400×1600 JPEG with a capture date and exact GPS in its EXIF, as a phone writes it. */
async function phonePhoto(index: number) {
  return sharp({
    create: { width: 2400, height: 1600, channels: 3, background: "#000", noise: { type: "gaussian", mean: 120 + index, sigma: 50 } },
  })
    .withExif({
      IFD0: { Model: "Curation Test Camera" },
      IFD2: { DateTimeOriginal: `2026:09:${String(4 + (index % 2)).padStart(2, "0")} 12:00:00` },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: dms(exactLat),
        GPSLongitudeRef: "W",
        GPSLongitude: dms(Math.abs(exactLon)),
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function dms(value: number) {
  const whole = Math.floor(value),
    minutes = (value - whole) * 60,
    minuteWhole = Math.floor(minutes),
    seconds = Math.round((minutes - minuteWhole) * 60 * 10000);
  return `${whole}/1 ${minuteWhole}/1 ${seconds}/10000`;
}

/** A 384-pixel frame of full-strength noise: about the largest thumbnail a photo can give. */
async function noisePhoto(index: number) {
  return sharp({
    create: { width: 384, height: 384, channels: 3, background: "#000", noise: { type: "gaussian", mean: 120 + index, sigma: 90 } },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
}

/** A PNG with no EXIF: no capture time and no GPS. */
async function plainPhoto() {
  return sharp({ create: { width: 800, height: 600, channels: 3, background: "#4a6b8a" } })
    .png()
    .toBuffer();
}

async function uploadPhotos({ repository, media, story }: Fixture, count: number, photo: (index: number) => Promise<Buffer> = phonePhoto) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      blobPath = `sources/${story.id}/${id}.jpg`;
    media.objects.set(blobPath, await photo(index));
    await repository.createUpload({
      id,
      storyId: story.id,
      blobPath,
      originalName: `${index}.jpg`,
      declaredType: "image/jpeg",
      status: "confirmed",
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)),
      confirmedAt: new Date(),
    });
    ids.push(id);
  }
  return ids;
}

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string };

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    response,
    isError: response.isError === true,
    content: response.content as ToolContent[],
    text: (response.content as ToolContent[])[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

type PhotoEntry = { id: string; capturedAt: string | null; place: { lat: number; lon: number; precision: string } | null };

async function current({ repository, story }: Fixture) {
  return (await repository.findStory(story.id)) as Story;
}

function curation(context: Fixture, version: number, photos: Array<{ id: string; caption: string }>) {
  return {
    storyId: context.story.id,
    version,
    title: "Fog on the headlands",
    intro: "Three days of sea stacks, tide pools and a cabin in the rain.",
    photos,
  };
}

// @verifies DES-WEB-MCP, DES-WEB-STORY, REQ-WEB-05
describe("BUI-2205 R1: get_photos returns small thumbnails of a story's uploads for Claude to review", () => {
  it("BUI-2205 R1: pages WebP image content under 1 MB per result with a cursor, capture dates and city-level places, never exact GPS", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 14),
      seen: string[] = [];
    let cursor: string | undefined,
      pages = 0;
    do {
      const page = await call(context.client, "get_photos", { storyId: context.story.id, ...(cursor ? { cursor } : {}) });
      expect(page.isError, page.text).toBe(false);
      pages += 1;
      const serialized = JSON.stringify(page.response);
      expect(Buffer.byteLength(serialized)).toBeLessThan(1_000_000);
      expect(serialized).not.toContain(String(exactLat).slice(0, 5));
      expect(serialized).not.toContain(String(exactLon).slice(0, 6));
      const photos = page.data?.photos as PhotoEntry[],
        images = page.content.filter(item => item.type === "image");
      expect(photos.length).toBeGreaterThan(0);
      expect(images).toHaveLength(photos.length);
      for (const [index, image] of images.entries()) {
        expect(image.mimeType).toBe("image/webp");
        const bytes = Buffer.from(image.data ?? "", "base64"),
          metadata = await sharp(bytes).metadata();
        expect(metadata.format).toBe("webp");
        expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(384);
        expect(metadata.exif).toBeUndefined();
        // Each image follows a text block naming its photo ID, so Claude can tell them apart.
        const label = page.content[page.content.indexOf(image) - 1];
        expect(label?.text).toContain(photos[index]!.id);
      }
      for (const photo of photos) {
        expect(photo.place).toEqual({ lat: 45.9, lon: -124, precision: expect.stringMatching(/city/i) });
        expect(photo.capturedAt).toMatch(/^2026-09-0[45]/);
      }
      seen.push(...photos.map(photo => photo.id));
      cursor = (page.data?.nextCursor as string | null) ?? undefined;
      expect(page.data?.total).toBe(14);
    } while (cursor && pages < 10);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(ids);
  });

  it("BUI-2205 R1: gives region-level places for broad stories and no place for hidden stories", async () => {
    for (const [privacy, place] of [
      ["broad", { lat: 46, lon: -124, precision: expect.stringMatching(/region/i) }],
      ["hidden", null],
    ] as const) {
      const context = await fixture(privacy);
      await uploadPhotos(context, 1);
      const page = await call(context.client, "get_photos", { storyId: context.story.id });
      expect(page.isError, page.text).toBe(false);
      expect((page.data?.photos as PhotoEntry[])[0]?.place).toEqual(place);
      expect(page.data?.nextCursor).toBeNull();
    }
  });

  it("BUI-2205 R1: refuses a cursor past the end and a story whose photos are no longer stored", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 2),
      past = await call(context.client, "get_photos", { storyId: context.story.id, cursor: "5" });
    expect(past.isError).toBe(true);
    expect(past.text).toMatch(/cursor/i);
    const saved = await call(context.client, "save_curation", curation(context, 0, [{ id: ids[0]!, caption: "A sea stack." }]));
    expect(saved.isError, saved.text).toBe(false);
    const after = await call(context.client, "get_photos", { storyId: context.story.id });
    expect(after.isError).toBe(true);
    expect(after.text).toMatch(/draft/i);
  });
  it("BUI-2205 R1: ends a page early when its images would pass the 1 MB result size, and the next page goes on from there", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 12, noisePhoto),
      first = await call(context.client, "get_photos", { storyId: context.story.id });
    expect(first.isError, first.text).toBe(false);
    const firstPhotos = first.data?.photos as PhotoEntry[];
    expect(firstPhotos.length).toBeLessThan(12);
    expect(Buffer.byteLength(JSON.stringify(first.response))).toBeLessThan(1_000_000);
    expect(first.data?.nextCursor).toBe(String(firstPhotos.length));
    const second = await call(context.client, "get_photos", { storyId: context.story.id, cursor: first.data?.nextCursor });
    expect(second.isError, second.text).toBe(false);
    expect([...firstPhotos, ...(second.data?.photos as PhotoEntry[])].map(photo => photo.id)).toEqual(ids);
    expect(second.data?.nextCursor).toBeNull();
  });

  it("BUI-2205 R1: reports no capture time and no place for a photo without EXIF", async () => {
    const context = await fixture();
    await uploadPhotos(context, 1, plainPhoto);
    const page = await call(context.client, "get_photos", { storyId: context.story.id });
    expect(page.isError, page.text).toBe(false);
    expect((page.data?.photos as PhotoEntry[])[0]).toMatchObject({ capturedAt: null, place: null });
  });

  it("BUI-2205 R1, R2: refuse another session's story and a story whose photos have expired", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 1),
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
    for (const [tool, args] of [
      ["get_photos", { storyId: stranger.id }],
      ["save_curation", { ...curation(context, 0, [{ id: ids[0]!, caption: "A sea stack." }]), storyId: stranger.id }],
    ] as const) {
      const refused = await call(context.client, tool, args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("another private session");
    }
    const story = await current(context);
    await context.repository.saveStory({ ...story, sourceExpiresAt: new Date(Date.now() - 1000) }, story.version);
    const expired = await call(context.client, "get_photos", { storyId: context.story.id });
    expect(expired.isError).toBe(true);
    expect(expired.text).toMatch(/expired/i);
    const unsaved = await call(
      context.client,
      "save_curation",
      curation(context, story.version + 1, [{ id: ids[0]!, caption: "A sea stack." }])
    );
    expect(unsaved.isError).toBe(true);
    expect(unsaved.text).toMatch(/expired/i);
  });
});

// @verifies DES-WEB-MCP, DES-WEB-STORY, REQ-WEB-05, REQ-WEB-07
describe("BUI-2205 R2: save_curation saves Claude's chosen photos and text as the story's draft", () => {
  it("BUI-2205 R2: saves the photos in order with their captions, title and intro, builds the derivatives and removes the originals", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 6),
      chosen = [ids[4]!, ids[0]!, ids[2]!],
      saved = await call(
        context.client,
        "save_curation",
        curation(
          context,
          0,
          chosen.map((id, index) => ({ id, caption: `Frame ${index + 1} of the coast.` }))
        )
      );
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.data).toMatchObject({ id: context.story.id, status: "draft", photoCount: 3 });
    const story = await current(context),
      manifest = story.manifest!;
    expect(story.status).toBe("draft");
    expect(story.activeRunId).toBeUndefined();
    expect(manifest.title).toBe("Fog on the headlands");
    expect(story.title).toBe("Fog on the headlands");
    expect(manifest.opening).toBe("Three days of sea stacks, tide pools and a cabin in the rain.");
    expect(manifest.photos.map(photo => photo.id)).toEqual(chosen);
    expect(manifest.photos.map(photo => photo.caption)).toEqual([
      "Frame 1 of the coast.",
      "Frame 2 of the coast.",
      "Frame 3 of the coast.",
    ]);
    expect(manifest.heroPhotoId).toBe(chosen[0]);
    expect(manifest.chapters.flatMap(chapter => chapter.photoIds)).toEqual(chosen);
    expect(manifest.route).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain(String(exactLat).slice(0, 5));
    const [run] = await context.repository.listRuns(story.id);
    expect(run).toMatchObject({ status: "complete" });
    for (const photo of manifest.photos)
      for (const path of [photo.srcLarge, photo.srcMedium, photo.srcThumb]) {
        const [revision, runId, name] = decodeURIComponent(path.split("/").at(-1)!).split("--");
        expect(path.startsWith(`/api/media/${story.id}/`)).toBe(true);
        expect(runId).toBe(run!.id);
        const bytes = context.media.objects.get(`derivatives/${story.id}/${revision}/${runId}/${name}`);
        expect(bytes, path).toBeDefined();
        const metadata = await sharp(bytes!).metadata();
        expect(metadata.format).toBe("webp");
        expect(metadata.exif).toBeUndefined();
      }
    expect([...context.media.objects.keys()].filter(key => key.startsWith("sources/"))).toEqual([]);
    expect((await context.repository.listUploads(story.id)).every(upload => upload.status === "deleted")).toBe(true);
  });

  it("BUI-2205 R2: rejects a photo ID that is not in the story and leaves the story unchanged", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 2),
      refused = await call(
        context.client,
        "save_curation",
        curation(context, 0, [
          { id: ids[0]!, caption: "A sea stack." },
          { id: "11111111-1111-4111-8111-111111111111", caption: "Not in this story." },
        ])
      );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("11111111-1111-4111-8111-111111111111");
    const story = await current(context);
    expect(story).toMatchObject({ status: "uploading", version: 0 });
    expect(await context.repository.listRuns(story.id)).toEqual([]);
    const repeated = await call(
      context.client,
      "save_curation",
      curation(context, 0, [
        { id: ids[0]!, caption: "A sea stack." },
        { id: ids[0]!, caption: "The same sea stack." },
      ])
    );
    expect(repeated.isError).toBe(true);
    expect(repeated.text).toMatch(/more than once/i);
  });

  it("BUI-2205 R2: rejects a title, intro or caption that names or identifies a person", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 1),
      texts = [
        { field: "caption", change: { photos: [{ id: ids[0]!, caption: "My wife on the beach." }] } },
        { field: "caption", change: { photos: [{ id: ids[0]!, caption: "Mr. Tanaka at the pier." }] } },
        { field: "title", change: { title: "Weekend with @sam_travels" } },
        { field: "intro", change: { intro: "A woman named Rosa showed us the cove." } },
        { field: "intro", change: { intro: "Jamie and I walked the headland." } },
      ];
    for (const { field, change } of texts) {
      const refused = await call(context.client, "save_curation", {
        ...curation(context, 0, [{ id: ids[0]!, caption: "A sea stack." }]),
        ...change,
      });
      expect(refused.isError, JSON.stringify(change)).toBe(true);
      expect(refused.text).toMatch(/person/i);
      expect(refused.text).toContain(field);
    }
    expect(await current(context)).toMatchObject({ status: "uploading", version: 0 });
  });

  it("BUI-2205 R2: rejects a plain given name or a family name for a person, but keeps place names that contain a given name", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 1);
    for (const caption of ["Maria on the bridge.", "Lunch with John Smith.", "Mom at the lookout.", "Grandma's favourite café."]) {
      const refused = await call(context.client, "save_curation", curation(context, 0, [{ id: ids[0]!, caption }]));
      expect(refused.isError, caption).toBe(true);
      expect(refused.text).toMatch(/person/i);
    }
    expect(await current(context)).toMatchObject({ status: "uploading", version: 0 });
    const places = [
        "The bell tower of Santa Maria.",
        "Dusk over Lake George.",
        "Boats at St. John's harbour.",
        "Rain on John Street.",
        "Morning in Playa del Carmen.",
        "The road to Alice Springs.",
        "Walking up to Arthur's Seat.",
      ].join(" "),
      saved = await call(context.client, "save_curation", curation(context, 0, [{ id: ids[0]!, caption: places.slice(0, 280) }]));
    expect(saved.isError, saved.text).toBe(false);
  });

  it("BUI-2205 R2: saves without a version, and get_photos takes a null cursor as the first page", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 2),
      first = await call(context.client, "get_photos", { storyId: context.story.id, cursor: null });
    expect(first.isError, first.text).toBe(false);
    expect((first.data?.photos as PhotoEntry[]).map(photo => photo.id)).toEqual(ids);
    const { version: _version, ...unversioned } = curation(context, 0, [{ id: ids[1]!, caption: "A tide pool." }]),
      saved = await call(context.client, "save_curation", unversioned);
    expect(_version).toBe(0);
    expect(saved.isError, saved.text).toBe(false);
    expect((await current(context)).manifest?.photos.map(photo => photo.id)).toEqual([ids[1]]);
  });

  it("BUI-2205 R2: saves a new curation over the draft from its stored photos, and refuses a stale version", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 3);
    await call(
      context.client,
      "save_curation",
      curation(
        context,
        0,
        ids.map(id => ({ id, caption: "A first caption." }))
      )
    );
    const draft = await current(context),
      edited = await call(context.client, "save_curation", {
        ...curation(context, draft.version, [
          { id: ids[2]!, caption: "Rain on the cabin roof." },
          { id: ids[1]!, caption: "A tide pool." },
        ]),
        title: "Rain on the coast",
      });
    expect(edited.isError, edited.text).toBe(false);
    const story = await current(context);
    expect(story.manifest?.photos.map(photo => [photo.id, photo.caption])).toEqual([
      [ids[2], "Rain on the cabin roof."],
      [ids[1], "A tide pool."],
    ]);
    expect(story.manifest?.photos[0]?.srcLarge).toBe(draft.manifest?.photos.find(photo => photo.id === ids[2])?.srcLarge);
    expect(story.title).toBe("Rain on the coast");
    const stale = await call(context.client, "save_curation", curation(context, draft.version, [{ id: ids[0]!, caption: "Old." }]));
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ conflict: true, currentVersion: story.version });
  });

  it("BUI-2205 R2: marks the story failed and removes its new derivatives when a photo cannot be read, and a retry succeeds", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 2),
      missing = `sources/${context.story.id}/${ids[1]}.jpg`;
    context.media.failing.add(missing);
    const failed = await call(
      context.client,
      "save_curation",
      curation(
        context,
        0,
        ids.map(id => ({ id, caption: "A coast frame." }))
      )
    );
    expect(failed.isError).toBe(true);
    const story = await current(context);
    expect(story.status).toBe("failed");
    expect(story.activeRunId).toBeUndefined();
    expect((await context.repository.listRuns(story.id))[0]).toMatchObject({ status: "failed" });
    expect([...context.media.objects.keys()].filter(key => key.startsWith("derivatives/"))).toEqual([]);
    expect(context.media.objects.has(missing)).toBe(true);
    context.media.failing.clear();
    const retried = await call(
      context.client,
      "save_curation",
      curation(
        context,
        story.version,
        ids.map(id => ({ id, caption: "A coast frame." }))
      )
    );
    expect(retried.isError, retried.text).toBe(false);
    expect((await current(context)).status).toBe("draft");
  });

  it("BUI-2205 R2: refuses a curation while story creation is switched off, and changes nothing", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 1);
    context.policy.enabled = false;
    Object.assign(context.policy, { ownerEnabled: false });
    const refused = await call(context.client, "save_curation", curation(context, 0, [{ id: ids[0]!, caption: "A sea stack." }]));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/unavailable/i);
    expect(await current(context)).toMatchObject({ status: "uploading", version: 0 });
    expect(await context.repository.listRuns(context.story.id)).toEqual([]);
  });

  it("BUI-2205 R2: refuses a published story", async () => {
    const context = await fixture(),
      ids = await uploadPhotos(context, 1);
    await call(context.client, "save_curation", curation(context, 0, [{ id: ids[0]!, caption: "A sea stack." }]));
    const draft = await current(context);
    await context.repository.saveStory({ ...draft, status: "published", publicSlug: "coast" }, draft.version);
    const refused = await call(context.client, "save_curation", curation(context, draft.version + 1, [{ id: ids[0]!, caption: "New." }]));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/unpublish/i);
  });
});

// @verifies REQ-AGENT-1, DES-WEB-MCP
describe("BUI-2205 R3: the skill has Claude curate the hosted page itself", () => {
  it("BUI-2205 R3: the hosted workflow calls get_photos, then has Claude choose, order and write, then calls save_curation", async () => {
    const skill = await readFile("skills/wanderpage/SKILL.md", "utf8"),
      description = /^description: (.*)$/m.exec(skill)?.[1] ?? "",
      hosted = skill.slice(skill.indexOf("## Hosted stories"), skill.indexOf("## Privacy rules")),
      upload = hosted.indexOf("`upload_photos`"),
      photos = hosted.indexOf("`get_photos`"),
      save = hosted.indexOf("`save_curation`");
    expect(description).toContain("get_photos");
    expect(description).toContain("save_curation");
    expect(upload).toBeGreaterThan(-1);
    expect(photos).toBeGreaterThan(upload);
    expect(save).toBeGreaterThan(photos);
    const between = hosted.slice(photos, save).replace(/\s+/g, " ");
    expect(between).toMatch(/choose/i);
    expect(between).toMatch(/order/i);
    expect(between).toMatch(/caption/i);
    expect(between).toMatch(/nextCursor/);
  });
});
