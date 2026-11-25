import { readFile } from "node:fs/promises";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import exifr from "exifr";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { curationLeaseMs, curationRevision, personTextProblem, StoryService, type CurationMedia } from "@/lib/web/story-service";
import type { LocationPrivacyMode, PeopleMode, Story, StoryRun } from "@/lib/web/types";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://trips.example.com",
  oneMegabyte = 1_000_000,
  lisbon = { lat: 38.71234, lon: -9.13987 };

let located: Buffer, unlocated: Buffer;

/** Large, noisy JPEGs, so a page of originals is far over 1 MB and only real previews fit; one carries capture date and exact GPS. */
beforeAll(async () => {
  const noisy = () =>
    sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#7a8c99", noise: { type: "gaussian", mean: 120, sigma: 40 } } });
  [located, unlocated] = await Promise.all([
    noisy()
      .withExif({
        IFD0: { Model: "Curation Test Camera" },
        IFD2: { DateTimeOriginal: "2026:09:04 12:00:00" },
        IFD3: gpsExif(lisbon.lat, lisbon.lon),
      })
      .jpeg({ quality: 90 })
      .toBuffer(),
    noisy()
      .withExif({ IFD2: { DateTimeOriginal: "2026:09:05 09:30:00" } })
      .jpeg({ quality: 90 })
      .toBuffer(),
  ]);
});

function gpsExif(lat: number, lon: number) {
  const degrees = (value: number) => {
    const whole = Math.floor(value),
      minutes = (value - whole) * 60,
      minuteWhole = Math.floor(minutes);
    return `${whole}/1 ${minuteWhole}/1 ${Math.round((minutes - minuteWhole) * 6000)}/100`;
  };
  return {
    GPSLatitudeRef: lat >= 0 ? "N" : "S",
    GPSLatitude: degrees(Math.abs(lat)),
    GPSLongitudeRef: lon >= 0 ? "E" : "W",
    GPSLongitude: degrees(Math.abs(lon)),
  };
}

async function fixture(dailyLimit = 25) {
  const repository = new MemoryStoryRepository(),
    sources = new Map<string, Buffer>(),
    written = new Map<string, Buffer>(),
    media: CurationMedia = {
      read: async upload => {
        const bytes = sources.get(upload.blobPath);
        if (!bytes) throw new Error(`no source for ${upload.id}`);
        return bytes;
      },
      write: async (pathname, bytes) => {
        written.set(pathname, bytes);
      },
    },
    validated: string[] = [],
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit }),
      async (_storyId, runId) => {
        validated.push(runId);
      },
      media
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner, publicOrigin: origin }),
    client = new Client({ name: "curation-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  async function story(peopleMode: PeopleMode = "exclude", locationPrivacy: LocationPrivacyMode = "approximate", photos = 7) {
    const created = await stories.createStory(await sessions.secretFor(owner), {
      title: "Lisbon in spring",
      peopleMode,
      locationPrivacy,
      termsVersion: currentDisclosureVersion,
      uploadConsentVersion: currentDisclosureVersion,
    });
    const ids: string[] = [];
    for (let index = 0; index < photos; index += 1) {
      const id = `${created.id.slice(0, 8)}-photo-${String(index).padStart(2, "0")}`,
        blobPath = `sources/${created.id}/${id}.jpg`;
      sources.set(blobPath, index === 0 ? located : unlocated);
      await repository.createUpload({
        id,
        storyId: created.id,
        blobPath,
        originalName: `${index}.jpg`,
        declaredType: "image/jpeg",
        status: "confirmed",
        createdAt: new Date(Date.UTC(2026, 10, 24, 0, 0, index)),
        confirmedAt: new Date(),
      });
      ids.push(id);
    }
    return { story: created, ids };
  }

  return { repository, stories, sessions, client, sources, written, validated, story };
}

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    content: response.content as Content,
    text: (response.content as Content)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
    bytes: JSON.stringify(response).length,
  };
}

/** `containsPeople: null` leaves the value out of every photo. */
const curation = (ids: string[], containsPeople: boolean | null = false) => ({
  title: "Tiles and tram lines",
  intro: "Three days of steep streets, river light and late lunches.",
  photos: ids.map((photoId, index) => ({
    photoId,
    caption: `Frame ${index + 1}: a tiled facade above the tram line.`,
    ...(containsPeople === null ? {} : { containsPeople }),
  })),
});

// @verifies DES-WEB-MCP, DES-WEB-STORY, ARCH-WEB-STORY, REQ-WEB-03
describe("BUI-2205 R1: get_photos returns small WebP previews a page at a time", () => {
  it("BUI-2205 R1: a page is image content under 1 MB with photo IDs, capture dates, a city-level place and the next cursor", async () => {
    const { client, story } = await fixture(),
      { story: created, ids } = await story("exclude", "approximate", 12);
    expect(located.length * ids.length).toBeGreaterThan(oneMegabyte);

    const first = await call(client, "get_photos", { storyId: created.id });
    expect(first.isError, first.text).toBe(false);
    expect(first.bytes).toBeLessThan(oneMegabyte);
    const images = first.content.filter(item => item.type === "image");
    expect(images.length).toBe(10);
    expect(images.every(image => image.mimeType === "image/webp")).toBe(true);
    const preview = await sharp(Buffer.from(images[0]!.data!, "base64")).metadata();
    expect(preview.format).toBe("webp");
    expect(Math.max(preview.width ?? 0, preview.height ?? 0)).toBeLessThanOrEqual(320);
    expect(preview.exif).toBeUndefined();

    const photos = first.data?.photos as Array<{ photoId: string; captureDate: string | null; place: unknown }>;
    expect(photos.map(photo => photo.photoId)).toEqual(ids.slice(0, 10));
    expect(photos[0]).toEqual({ photoId: ids[0], captureDate: "2026-09-04", place: { lat: 38.7, lon: -9.1, precision: "about 11 km" } });
    expect(photos[1]).toMatchObject({ captureDate: "2026-09-05", place: null });
    expect(first.data?.nextCursor).toBe("10");
    expect(JSON.stringify(first.content)).not.toMatch(/38\.71|-9\.13|9\.14/);
    const labels = first.content.filter(item => item.type === "text").map(item => item.text);
    expect(labels).toContain(`photoId ${ids[0]}:`);

    const second = await call(client, "get_photos", { storyId: created.id, cursor: "10" });
    const numeric = await call(client, "get_photos", { storyId: created.id, cursor: 10 }),
      unset = await call(client, "get_photos", { storyId: created.id, cursor: null });
    expect(numeric.data?.photos).toEqual(second.data?.photos);
    expect(unset.data?.photos).toEqual(first.data?.photos);
    expect(second.isError, second.text).toBe(false);
    expect((second.data?.photos as Array<{ photoId: string }>).map(photo => photo.photoId)).toEqual(ids.slice(10));
    expect(second.data?.nextCursor).toBeNull();
  });

  it("BUI-2205 R1: broad stories get a region-level place and hidden stories get none", async () => {
    const { client, story } = await fixture(),
      broad = await story("include", "broad", 1),
      hidden = await story("include", "hidden", 1),
      broadPage = await call(client, "get_photos", { storyId: broad.story.id }),
      hiddenPage = await call(client, "get_photos", { storyId: hidden.story.id });
    expect((broadPage.data?.photos as Array<{ place: unknown }>)[0]?.place).toEqual({ lat: 39, lon: -9, precision: "about 110 km" });
    expect((hiddenPage.data?.photos as Array<{ place: unknown }>)[0]?.place).toBeNull();
    expect(JSON.stringify(hiddenPage.content)).not.toMatch(/38\.7|-9\.1/);
  });

  it("BUI-2205 R1: refuses a cursor past the last photo and a story that is no longer uploading", async () => {
    const { client, story, repository } = await fixture(),
      { story: created } = await story("exclude", "approximate", 2),
      past = await call(client, "get_photos", { storyId: created.id, cursor: "3" });
    expect(past.isError).toBe(true);
    expect(past.text).toMatch(/cursor/);
    const current = (await repository.findStory(created.id))!;
    await repository.saveStory({ ...current, status: "queued" }, current.version);
    const queued = await call(client, "get_photos", { storyId: created.id });
    expect(queued.isError).toBe(true);
    expect(queued.text).toMatch(/queued/);
  });
});

// @verifies DES-WEB-MCP, DES-WEB-STORY, ARCH-WEB-STORY, REQ-WEB-05
describe("BUI-2205 R2: save_curation saves Claude's curation as the draft", () => {
  it("BUI-2205 R2: saves the chosen photos in order with Claude's captions, title and intro as a draft that publishes", async () => {
    const { client, story, repository, written, validated } = await fixture(),
      { story: created, ids } = await story("exclude", "approximate", 7),
      chosen = [ids[3]!, ids[0]!, ids[5]!],
      saved = await call(client, "save_curation", { storyId: created.id, ...curation(chosen), closing: "Back down to the river." });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.data).toMatchObject({ id: created.id, status: "draft", title: "Tiles and tram lines", photoCount: 3 });

    const draft = (await repository.findStory(created.id))!,
      manifest = draft.manifest!;
    expect(draft.title).toBe("Tiles and tram lines");
    expect(manifest.title).toBe("Tiles and tram lines");
    expect(manifest.opening).toBe("Three days of steep streets, river light and late lunches.");
    expect(manifest.closing).toBe("Back down to the river.");
    expect(manifest.heroPhotoId).toBe(ids[3]);
    expect(manifest.photos.map(photo => photo.id)).toEqual(chosen);
    expect(manifest.photos.map(photo => photo.caption)).toEqual(curation(chosen).photos.map(photo => photo.caption));
    expect(manifest.chapters.flatMap(chapter => chapter.photoIds)).toEqual(chosen);
    expect(manifest.destinations).toEqual([]);
    expect(manifest.route).toEqual([]);

    const [run] = (await repository.listRuns(created.id)) as StoryRun[];
    expect(run).toMatchObject({ processorRevision: curationRevision, status: "complete" });
    for (const photo of manifest.photos)
      for (const path of [photo.srcLarge, photo.srcMedium, photo.srcThumb]) {
        const name = decodeURIComponent(path.slice(`/api/media/${created.id}/`.length)),
          [revision, runId, file] = name.split("--"),
          bytes = written.get(`derivatives/${created.id}/${revision}/${runId}/${file}`);
        expect(revision).toBe(curationRevision);
        expect(runId).toBe(run!.id);
        expect(bytes, path).toBeDefined();
        expect((await sharp(bytes!).metadata()).format).toBe("webp");
        expect(await exifr.gps(bytes!).catch(() => undefined)).toBeUndefined();
      }

    const published = await call(client, "publish", { storyId: created.id });
    expect(published.isError, published.text).toBe(false);
    expect(validated).toEqual([run!.id]);
  });

  it("BUI-2205 R2: a build that fails marks the run and story failed, and the curation can be saved again", async () => {
    const { client, story, repository, sources } = await fixture(),
      { story: created, ids } = await story("exclude", "approximate", 7),
      missing = (await repository.findUpload(ids[1]!))!,
      original = sources.get(missing.blobPath)!;
    sources.delete(missing.blobPath);
    const failed = await call(client, "save_curation", { storyId: created.id, ...curation(ids.slice(0, 3)) });
    expect(failed.isError).toBe(true);
    expect((await repository.findStory(created.id))?.status).toBe("failed");
    expect(await repository.listRuns(created.id)).toEqual([
      expect.objectContaining({ processorRevision: curationRevision, status: "failed", errorCode: "CURATION_FAILED" }),
    ]);

    sources.set(missing.blobPath, original);
    const retried = await call(client, "save_curation", { storyId: created.id, ...curation(ids.slice(0, 3)) });
    expect(retried.isError, retried.text).toBe(false);
    expect((await repository.findStory(created.id))?.status).toBe("draft");
  });

  it("BUI-2205 R2: a build whose request died is taken over after its lease, and a live build is not", async () => {
    const { client, story, repository } = await fixture(),
      stuck = async (age: number) => {
        const { story: created, ids } = await story("exclude", "approximate", 7),
          at = new Date(Date.now() - age),
          runId = crypto.randomUUID();
        await repository.queueRun(
          { ...created, processorRevision: curationRevision },
          {
            id: runId,
            storyId: created.id,
            processorRevision: curationRevision,
            admissionKey: "client",
            admittedAt: at,
            status: "queued",
            stage: "queued",
            progress: 0,
            attempts: 0,
            sourceUploadIds: [],
            updatedAt: at,
          },
          { sessionStarts: 99, clientStarts: 99, globalStarts: 99, since: at, now: new Date(), minPhotos: 1 }
        );
        await repository.claimRun(created.id, runId, at);
        return { created, ids, runId };
      };

    const live = await stuck(60 * 1000),
      refused = await call(client, "save_curation", { storyId: live.created.id, ...curation(live.ids.slice(0, 2)) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/still being built.*call it again after/);
    expect((await repository.findStory(live.created.id))?.status).toBe("processing");
    expect((await repository.findRun(live.runId))?.status).toBe("processing");

    const dead = await stuck(curationLeaseMs + 1000),
      progress = vi.spyOn(repository, "markRunProgress");
    expect((await call(client, "get_photos", { storyId: dead.created.id })).isError).toBe(false);
    expect((await repository.findStory(dead.created.id))?.status).toBe("processing");
    const saved = await call(client, "save_curation", { storyId: dead.created.id, ...curation(dead.ids.slice(0, 3)) });
    expect(saved.isError, saved.text).toBe(false);
    expect((await repository.findStory(dead.created.id))?.status).toBe("draft");
    expect(await repository.findRun(dead.runId)).toMatchObject({ status: "failed", errorCode: "CURATION_INTERRUPTED" });
    // Every finished photo renews the new build's lease.
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("BUI-2205 R1, R2: refuses an original over 80 megapixels before resizing it", async () => {
    const { client, story, repository, sources } = await fixture(),
      { story: created, ids } = await story("include", "approximate", 2),
      upload = (await repository.findUpload(ids[0]!))!;
    sources.set(
      upload.blobPath,
      await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#888" } })
        .jpeg({ quality: 10 })
        .toBuffer()
    );
    const page = await call(client, "get_photos", { storyId: created.id });
    expect(page.isError).toBe(true);
    expect(page.text).toMatch(/80 megapixel/);
    const saved = await call(client, "save_curation", { storyId: created.id, ...curation(ids) });
    expect(saved.isError).toBe(true);
    expect(saved.text).toMatch(/80 megapixel/);
  });

  it("BUI-2205 R2: rejects a photo ID that is not in the story and stores nothing", async () => {
    const { client, story, repository, written } = await fixture(),
      { story: created, ids } = await story("exclude", "approximate", 7),
      other = await story("exclude", "approximate", 1),
      refused = await call(client, "save_curation", { storyId: created.id, ...curation([ids[0]!, other.ids[0]!, "made-up-photo"]) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(other.ids[0]);
    expect(refused.text).toContain("made-up-photo");
    expect((await repository.findStory(created.id))?.status).toBe("uploading");
    expect(await repository.listRuns(created.id)).toEqual([]);
    expect(written.size).toBe(0);
  });

  it("BUI-2205 R2: rejects text that names or identifies a person", async () => {
    const { client, story, repository } = await fixture(),
      { story: created, ids } = await story("include", "approximate", 7),
      base = curation(ids.slice(0, 2)),
      attempts = [
        { ...base, title: "Lisbon with Mr. Silva" },
        { ...base, intro: "My wife and I walked the Alfama." },
        { ...base, photos: [{ ...base.photos[0]!, caption: "Lunch with @ana.lisboa by the river" }, base.photos[1]!] },
        { ...base, closing: "Our friends waved from the ferry." },
        { ...base, photos: [{ ...base.photos[0]!, caption: "Maria smiling by the river" }, base.photos[1]!] },
        { ...base, intro: "Lunch with John and Sarah before the tram." },
      ];
    for (const attempt of attempts) {
      const refused = await call(client, "save_curation", { storyId: created.id, ...attempt });
      expect(refused.isError, JSON.stringify(attempt)).toBe(true);
      expect(refused.text).toMatch(/names or identifies a person/);
    }
    expect((await repository.findStory(created.id))?.status).toBe("uploading");
    expect(personTextProblem("A tiled facade above the tram line, with a stranger's shadow.")).toBeUndefined();
    expect(personTextProblem("João at the viewpoint.")).toBe('the name "João"');
    expect(personTextProblem("Coffee with Dona Rosa.")).toBe("a title before a name");
    // A given name that is part of a place or building is scene text, not a person.
    for (const place of [
      "Sunset over São João.",
      "The Charles Bridge at dawn.",
      "St. Paul's Cathedral from the hill.",
      "Praça Dom Pedro IV.",
      "Rua Dona Estefânia at noon.",
      // A title before a lowercase word or a place noun is not a name.
      "The Lady Chapel at dusk.",
      "Our Lady of Fatima chapel at dawn.",
      "Our Lady of Fatima at dawn.",
      "The old papa bear statue.",
      "Sir walls and lord knows how many steps.",
      // A name inside a place name or a dedication is scene text.
      "Vasco da Gama Bridge at dusk.",
      "Monument to Henry the Navigator.",
      "A statue of Pedro in the square.",
    ])
      expect(personTextProblem(place), place).toBeUndefined();
  });

  it("BUI-2205 R2: curation runs never use up the paid generation limit", async () => {
    const { client, story, stories, sessions, repository } = await fixture(1),
      curated = await story("exclude", "approximate", 7),
      generated = await story("exclude", "approximate", 7),
      later = await story("exclude", "approximate", 7);
    expect((await call(client, "save_curation", { storyId: curated.story.id, ...curation(curated.ids.slice(0, 2)) })).isError).toBe(false);
    // The daily limit is 1: the curation above must not have used it.
    const queued = await stories.queueGeneration(await sessions.secretFor(owner), generated.story.id, "client");
    expect(queued.status).toBe("queued");
    // The paid limit is now reached, and curation still works.
    const after = await call(client, "save_curation", { storyId: later.story.id, ...curation(later.ids.slice(0, 2)) });
    expect(after.isError, after.text).toBe(false);
    expect((await repository.findStory(later.story.id))?.status).toBe("draft");
  });

  it("BUI-2205 R2: a deleted curated story's run still stays out of the paid generation limit", async () => {
    const { client, story, stories, sessions, repository } = await fixture(1),
      curated = await story("exclude", "approximate", 7),
      generated = await story("exclude", "approximate", 7),
      secret = await sessions.secretFor(owner);
    expect((await call(client, "save_curation", { storyId: curated.story.id, ...curation(curated.ids.slice(0, 2)) })).isError).toBe(false);
    await stories.prepareDelete(secret, curated.story.id);
    await repository.finishDeleteStory(curated.story.id, new Date(Date.now() + 60 * 60 * 1000));
    expect(await repository.listRuns(curated.story.id)).toEqual([expect.objectContaining({ processorRevision: curationRevision })]);
    // The daily limit is 1: the deleted story's curation run must not have used it.
    expect((await stories.queueGeneration(secret, generated.story.id, "client")).status).toBe("queued");
  });

  it("BUI-2205 R2: the Neon tombstone keeps a curation run's revision and marks every other run deleted", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [],
      sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ text: parts.join("?").replace(/\s+/g, " "), values });
        return [{ status: "deleted" }];
      }) as unknown as NeonQueryFunction<false, false>;
    await new NeonStoryRepository(sql).finishDeleteStory("story", new Date("2026-11-24T00:00:00Z"));
    const [tombstone] = statements;
    expect(tombstone?.text).toMatch(
      /UPDATE story_runs SET [^;]*processor_revision = CASE WHEN processor_revision = \? THEN processor_revision ELSE 'deleted' END/
    );
    expect(tombstone?.values).toContain(curationRevision);
  });

  it("BUI-2205 R2: the Neon admission query leaves curation runs out of every generation count", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [],
      now = new Date("2026-11-24T00:00:00Z"),
      row = {
        id: "story",
        owner_session_id: "session",
        status: "queued",
        title: "Lisbon",
        people_mode: "exclude",
        location_privacy: "approximate",
        processor_revision: "web-v1",
        source_expires_at: new Date("2026-11-25T00:00:00Z"),
        created_at: now,
        updated_at: now,
        version: 1,
      },
      sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ text: parts.join("?").replace(/\s+/g, " "), values });
        return [row];
      }) as unknown as NeonQueryFunction<false, false>,
      story: Story = {
        id: "story",
        ownerSessionId: "session",
        status: "uploading",
        title: "Lisbon",
        peopleMode: "exclude",
        locationPrivacy: "approximate",
        processorRevision: "web-v1",
        sourceExpiresAt: new Date("2026-11-25T00:00:00Z"),
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
    await new NeonStoryRepository(sql).queueRun(
      story,
      {
        id: "run",
        storyId: "story",
        processorRevision: "web-v1",
        admissionKey: "client",
        admittedAt: now,
        status: "queued",
        stage: "queued",
        progress: 0,
        attempts: 0,
        sourceUploadIds: [],
        updatedAt: now,
      },
      { sessionStarts: 3, clientStarts: 6, globalStarts: 25, since: now, now, minPhotos: 6 }
    );
    const [admission] = statements;
    expect(admission?.text.match(/count\(\*\) FROM story_runs/g)?.length).toBe(3);
    expect(admission?.text.match(/processor_revision <> \?/g)?.length).toBe(3);
    expect(admission?.values.filter(value => value === curationRevision).length).toBe(3);
  });
});

// @verifies DES-WEB-MCP, DES-WEB-STORY, ARCH-WEB-STORY, REQ-SEL-02
describe("BUI-2205 R3: save_curation fails closed on people in a story that excludes them", () => {
  it("BUI-2205 R3: rejects a photo marked containsPeople: true", async () => {
    const { client, story, repository } = await fixture(),
      { story: created, ids } = await story("exclude", "approximate", 7),
      input = curation(ids.slice(0, 3));
    input.photos[1] = { ...input.photos[1]!, containsPeople: true };
    const refused = await call(client, "save_curation", { storyId: created.id, ...input });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(ids[1]);
    expect((await repository.findStory(created.id))?.status).toBe("uploading");
  });

  it("BUI-2205 R3: rejects a photo with no containsPeople value", async () => {
    const { client, story, repository } = await fixture(),
      { story: created, ids } = await story("exclude", "approximate", 7),
      input = curation(ids.slice(0, 3));
    input.photos[2] = { photoId: input.photos[2]!.photoId, caption: input.photos[2]!.caption };
    const refused = await call(client, "save_curation", { storyId: created.id, ...input });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/containsPeople/);
    expect(refused.text).toContain(ids[2]);
    expect((await repository.findStory(created.id))?.status).toBe("uploading");
  });

  it("BUI-2205 R3: stores only the containsPeople values Claude sent, and never an unsent false", async () => {
    const { client, story, repository } = await fixture(),
      excluded = await story("exclude", "approximate", 7),
      included = await story("include", "approximate", 7);
    expect(
      (await call(client, "save_curation", { storyId: excluded.story.id, ...curation(excluded.ids.slice(0, 2), false) })).isError
    ).toBe(false);
    expect((await repository.findStory(excluded.story.id))?.manifest?.photos.map(photo => photo.containsPeople)).toEqual([false, false]);

    const mixed = curation(included.ids.slice(0, 3), null);
    mixed.photos[0] = { ...mixed.photos[0]!, containsPeople: false };
    mixed.photos[1] = { ...mixed.photos[1]!, containsPeople: true };
    const saved = await call(client, "save_curation", { storyId: included.story.id, ...mixed });
    expect(saved.isError, saved.text).toBe(false);
    // The third photo had no value: it is stored as "may show a person", never as false.
    expect((await repository.findStory(included.story.id))?.manifest?.photos.map(photo => photo.containsPeople)).toEqual([
      false,
      true,
      true,
    ]);
  });
});

// @verifies REQ-AGENT-1
describe("BUI-2205 R4: the skill has Claude curate the page itself", () => {
  it("BUI-2205 R4: the hosted skill calls get_photos, writes the text itself, then calls save_curation", async () => {
    const skill = await readFile("skills/wanderpage/SKILL.md", "utf8"),
      description = /^description: (.*)$/m.exec(skill)?.[1] ?? "",
      hosted = skill.slice(skill.indexOf("## Hosted stories")),
      upload = hosted.indexOf("`upload_photos`"),
      photos = hosted.indexOf("`get_photos`"),
      save = hosted.indexOf("`save_curation`");
    expect(description).toContain("get_photos");
    expect(description).toContain("save_curation");
    expect(upload).toBeGreaterThan(-1);
    expect(photos).toBeGreaterThan(upload);
    expect(save).toBeGreaterThan(photos);
    const step = hosted.slice(photos, save).replace(/\s+/g, " ");
    expect(step).toMatch(/choose and order/i);
    expect(step).toMatch(/captions?/i);
    expect(step).toMatch(/yourself/i);
  });
});
