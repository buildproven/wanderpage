import { inflateRawSync, crc32 } from "node:zlib";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import type { TripManifest } from "@/lib/schemas/trip";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import { downloadLinkKey, DownloadLinks, MemoryDownloadLinkStore, sealDownloadLink } from "@/lib/web/download-link";
import { createDownloadHandlers } from "@/app/api/mcp/_hosted/download-page";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

const origin = "https://wanderpage.example",
  pepper = ["download", "route", "pepper", "value", "long", "enough", "here"].join("-"),
  originalMarker = "ORIGINAL-UPLOAD-BYTES-WITH-EXIF-AND-GPS",
  storyInput = {
    title: "Kyoto <in> autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

async function webp(color: string) {
  return new Uint8Array(
    await sharp({ create: { width: 8, height: 6, channels: 3, background: color } })
      .webp()
      .toBuffer()
  );
}

function manifestFor(storyId: string): TripManifest {
  const media = (name: string) => `/api/media/${storyId}/rev1--run1--${name}`,
    photo = (id: number, extra: Partial<TripManifest["photos"][number]> = {}): TripManifest["photos"][number] => ({
      id: `p${id}`,
      srcLarge: media(`p${id}-large.webp`),
      srcMedium: media(`p${id}-medium.webp`),
      srcThumb: media(`p${id}-thumb.webp`),
      width: 8,
      height: 6,
      alt: `Alt <${id}>`,
      caption: `Caption ${id} & more`,
      captureTime: "2026-10-05T08:30:00Z",
      containsPeople: false,
      source: "user",
      ...extra,
    });
  return {
    schemaVersion: "1.0",
    generatedAt: "2026-11-01T00:00:00Z",
    published: true,
    title: "Kyoto <in> autumn",
    subtitle: "Temples and maple leaves",
    opening: "Opening words.",
    closing: "Closing words.",
    dateRange: { start: "2026-10-01", end: "2026-10-09" },
    peopleMode: "exclude",
    theme: { background: "#111111", foreground: "#eeeeee", accent: "#d96b47", muted: "#888888" },
    heroPhotoId: "p1",
    stats: [{ label: "Days", value: "9" }],
    destinations: [
      {
        id: "d1",
        name: "Kyoto",
        region: "Kansai",
        country: "Japan",
        confidence: 0.9,
        approximateCoordinate: { lat: 35.01161, lon: 135.76811 },
        introduction: "A city of temples.",
        facts: [{ text: "Kyoto was the capital for over a thousand years.", sourceId: "s1" }],
      },
    ],
    route: [{ destinationId: "d1", sequence: 1, lat: 35.01161, lon: 135.76811 }],
    chapters: [
      { id: "c1", title: "Arrival", destinationId: "d1", narrative: "We arrived.", photoIds: ["p1", "p2"], layout: "split" },
      { id: "c2", title: "Gardens", narrative: "Quiet gardens.", photoIds: ["p3"], layout: "hero" },
    ],
    photos: [photo(1), photo(2), photo(3)],
    sources: [
      { id: "s1", title: "Kyoto, Wikipedia", url: "https://en.wikipedia.org/wiki/Kyoto", provider: "Wikipedia", license: "CC BY-SA" },
    ],
  };
}

async function fixture(options: { status?: "draft" | "published" | "queued"; missing?: string } = {}) {
  const repository = new MemoryStoryRepository(),
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit: 25 })
    ),
    created = await stories.createSessionWithStory(storyInput, "client"),
    manifest = manifestFor(created.story.id),
    status = options.status ?? "draft";
  await repository.saveStory(
    { ...created.story, status, manifest, publicSlug: status === "published" ? "kyoto-autumn-abc123" : undefined },
    created.story.version
  );
  const store = new MemoryDownloadLinkStore(),
    clock = { now: new Date() },
    links = new DownloadLinks({ store, key: downloadLinkKey(pepper), now: () => clock.now }),
    reads: string[] = [],
    files = new Map<string, Uint8Array>();
  for (const [index, color] of ["#336699", "#993366", "#669933"].entries())
    files.set(`rev1--run1--p${index + 1}-large.webp`, await webp(color));
  for (const [index, color] of ["#336699", "#993366", "#669933"].entries())
    files.set(`rev1--run1--p${index + 1}-medium.webp`, await webp(color));
  // The originals live under sources/, which the reader is never asked for.
  const originals = new Map([[`sources/${created.story.id}/IMG_0001.jpg`, new TextEncoder().encode(originalMarker)]]),
    readDerivative = async (storyId: string, filename: string) => {
      reads.push(`${storyId}/${filename}`);
      return filename === options.missing ? undefined : files.get(filename);
    },
    handlers = createDownloadHandlers(() => ({ stories, links, readDerivative })),
    issued = await links.issue(created.story.id, created.rawSecret);
  return { stories, store, clock, links, handlers, created, token: issued.token, reads, files, originals, repository };
}

const get = (token: string) => new Request(`${origin}/download/${token}`);
const post = (token: string, headers: Record<string, string> = {}) =>
  new Request(`${origin}/download/${token}`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "",
  });

type ZipEntry = { name: string; data: Buffer; method: number; crc: number };

/** Reads a ZIP from its central directory and checks every entry's CRC-32 and size. */
function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const buffer = Buffer.from(bytes),
    end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("no end of central directory");
  const count = buffer.readUInt16LE(end + 10),
    entries = new Map<string, ZipEntry>();
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buffer.readUInt16LE(offset + 10),
      crc = buffer.readUInt32LE(offset + 16),
      compressed = buffer.readUInt32LE(offset + 20),
      size = buffer.readUInt32LE(offset + 24),
      nameLength = buffer.readUInt16LE(offset + 28),
      extraLength = buffer.readUInt16LE(offset + 30),
      commentLength = buffer.readUInt16LE(offset + 32),
      local = buffer.readUInt32LE(offset + 42),
      name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("bad local header");
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28),
      raw = buffer.subarray(dataStart, dataStart + compressed),
      data = method === 8 ? inflateRawSync(raw) : raw;
    if (method !== 0 && method !== 8) throw new Error(`unsupported method ${method}`);
    if (data.length !== size) throw new Error(`${name}: size mismatch`);
    if (crc32(data) !== crc) throw new Error(`${name}: crc mismatch`);
    entries.set(name, { name, data: Buffer.from(data), method, crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function localReferences(html: string) {
  return [...html.matchAll(/\b(?:src|href|poster|srcset|data|action)="([^"]*)"/g)]
    .map(match => match[1] ?? "")
    .filter(value => value && !value.startsWith("#") && !/^https?:\/\//.test(value));
}

async function downloaded(options: Parameters<typeof fixture>[0] = {}) {
  const context = await fixture(options),
    response = await context.handlers.POST(post(context.token), context.token),
    bytes = new Uint8Array(await response.arrayBuffer());
  return { ...context, response, bytes };
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01, REQ-WEB-10
describe("download link page (BUI-2146)", () => {
  it("BUI-2146 R3: GET shows the escaped story title and a Download form and leaves the link unused", async () => {
    const { handlers, store, token, reads } = await fixture(),
      response = await handlers.GET(get(token), token),
      html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain("Kyoto &lt;in&gt; autumn");
    expect(html).not.toContain("<in>");
    expect(html).toContain(`<form method="post" action="/download/${token}">`);
    expect(html).toContain(">Download</button>");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(store.rows()[0]?.usedAt).toBeUndefined();
    expect((await handlers.GET(get(token), token)).status).toBe(200);
    expect(reads).toEqual([]);
  });

  it("BUI-2146 R4: POST answers a ZIP named after the story slug, once", async () => {
    const { response, bytes, store } = await downloaded({ status: "published" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="kyoto-autumn-abc123.zip"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(bytes.length).toBeGreaterThan(100);
    expect(store.rows()[0]?.usedAt).toBeInstanceOf(Date);
  });

  it("BUI-2146 R4: a draft without a public slug is named after its title", async () => {
    const { response } = await downloaded({ status: "draft" });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="kyoto-in-autumn.zip"');
  });

  it("BUI-2146 R4: the ZIP holds index.html and the derived images, every reference in index.html is a relative file in the ZIP", async () => {
    const { bytes, files } = await downloaded(),
      zip = readZip(bytes),
      html = zip.get("index.html")?.data.toString("utf8") ?? "";
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Kyoto &lt;in&gt; autumn");
    expect(html).toContain("Opening words.");
    expect(html).toContain("Arrival");
    expect(html).toContain("Kyoto was the capital for over a thousand years.");
    expect(html).toContain("Caption 1 &amp; more");
    expect(html).toContain("Alt &lt;1&gt;");
    const references = localReferences(html);
    expect(references.length).toBeGreaterThanOrEqual(3);
    for (const reference of references) {
      expect(reference, reference).not.toMatch(/^[/\\]|^\.\.|:|\/\//);
      expect(zip.has(reference), `${reference} is in the ZIP`).toBe(true);
    }
    expect(html).not.toMatch(/\/api\/media|<script|<iframe|@import|url\(\s*["']?https?:/);
    for (const [name, entry] of zip) {
      if (name === "index.html") continue;
      expect(name).toMatch(/^images\/[A-Za-z0-9._-]+\.webp$/);
      expect([...files.values()].some(file => Buffer.from(file).equals(entry.data))).toBe(true);
    }
    // The three large images the page shows; the medium and thumbnail copies are not needed.
    expect([...zip.keys()].filter(name => name !== "index.html")).toHaveLength(3);
  });

  it("BUI-2146 R4: the ZIP has no original upload, no EXIF or GPS data and nothing the page does not show", async () => {
    const { bytes, reads, created, originals } = await downloaded(),
      zip = readZip(bytes),
      html = zip.get("index.html")?.data.toString("utf8") ?? "";
    for (const [path] of originals) expect(reads.some(read => read.includes(path))).toBe(false);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read).toMatch(new RegExp(`^${created.story.id}/rev1--run1--p\\d-large\\.webp$`));
    expect(Buffer.from(bytes).includes(Buffer.from(originalMarker))).toBe(false);
    for (const entry of zip.values()) {
      if (!entry.name.endsWith(".webp")) continue;
      const metadata = await sharp(entry.data).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
    }
    for (const hidden of [
      "35.01161",
      "135.76811",
      "approximateCoordinate",
      "latitude",
      "longitude",
      "35.0",
      "135.7",
      "2026-10-05T08:30",
      "IMG_0001",
      "sources/",
      "sourceId",
    ])
      expect(html, hidden).not.toContain(hidden);
    expect(html).not.toContain(created.rawSecret);
    expect(html).not.toContain(created.story.id);
    expect(Buffer.from(bytes).includes(Buffer.from(created.rawSecret))).toBe(false);
  });

  it("BUI-2146 R4: a story with hidden locations still downloads with no place names the page would not show", async () => {
    const { handlers, token, repository, created } = await fixture(),
      story = await repository.findStory(created.story.id);
    if (!story?.manifest) throw new Error("expected a manifest");
    await repository.saveStory(
      {
        ...story,
        locationPrivacy: "hidden",
        manifest: {
          ...story.manifest,
          destinations: [],
          route: [],
          chapters: story.manifest.chapters.map(chapter => ({ ...chapter, destinationId: undefined })),
        },
      },
      story.version
    );
    const response = await handlers.POST(post(token), token);
    expect(response.status).toBe(200);
    const html =
      readZip(new Uint8Array(await response.arrayBuffer()))
        .get("index.html")
        ?.data.toString("utf8") ?? "";
    expect(html).not.toContain("Kyoto was the capital");
    expect(html).not.toContain("field entry");
  });

  it("BUI-2146 R4: a theme colour that is not a hex colour never reaches the page's style", async () => {
    const { handlers, token, repository, created } = await fixture(),
      story = await repository.findStory(created.story.id);
    if (!story?.manifest) throw new Error("expected a manifest");
    await repository.saveStory(
      { ...story, manifest: { ...story.manifest, theme: { ...story.manifest.theme, accent: "red;}</style><script>alert(1)</script>" } } },
      story.version
    );
    const html =
      readZip(new Uint8Array(await (await handlers.POST(post(token), token)).arrayBuffer()))
        .get("index.html")
        ?.data.toString("utf8") ?? "";
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("BUI-2146 R5: the second POST answers 410 and GET then says the link is no longer valid", async () => {
    const { handlers, token } = await fixture();
    expect((await handlers.POST(post(token), token)).status).toBe(200);
    const again = await handlers.POST(post(token), token);
    expect(again.status).toBe(410);
    expect(again.headers.get("content-type")).toContain("text/html");
    expect(await again.text()).toContain("This download link is no longer valid.");
    const page = await handlers.GET(get(token), token);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This download link is no longer valid.");
  });

  it("BUI-2146 R5: an expired token answers 410 on POST and GET and stays unused", async () => {
    const { handlers, clock, token, store } = await fixture();
    clock.now = new Date(clock.now.getTime() + 15 * 60 * 1000 + 1);
    expect((await handlers.POST(post(token), token)).status).toBe(410);
    const page = await handlers.GET(get(token), token);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This download link is no longer valid.");
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R5: a forged, tampered or upload-key token answers 410 and leaves the real link unused", async () => {
    const { handlers, store, token, created } = await fixture(),
      forged = sealDownloadLink(
        {
          linkId: store.rows()[0]?.id ?? "",
          storyId: created.story.id,
          expiresAt: new Date(Date.now() + 60_000),
          ownerSecret: created.rawSecret,
        },
        downloadLinkKey(`${pepper}-attacker`)
      ),
      tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    for (const value of [forged, tampered, "garbage"]) {
      expect((await handlers.POST(post(value), value)).status).toBe(410);
      expect((await handlers.GET(get(value), value)).status).toBe(410);
    }
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R5: a link whose story was deleted, or is no longer a draft or published story, answers 410 and stays unused", async () => {
    const deleted = await fixture();
    await deleted.stories.prepareDelete(deleted.created.rawSecret, deleted.created.story.id);
    expect((await deleted.handlers.POST(post(deleted.token), deleted.token)).status).toBe(410);
    expect(deleted.store.rows()[0]?.usedAt).toBeUndefined();
    const queued = await fixture({ status: "queued" });
    expect((await queued.handlers.GET(get(queued.token), queued.token)).status).toBe(410);
    expect((await queued.handlers.POST(post(queued.token), queued.token)).status).toBe(410);
    expect(queued.store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R4: a cross-origin or non-form POST is refused with 403 and leaves the link unused", async () => {
    const { handlers, store, token } = await fixture(),
      crossSite = await handlers.POST(post(token, { origin: "https://attacker.example" }), token),
      noOrigin = await handlers.POST(
        new Request(`${origin}/download/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } }),
        token
      ),
      json = await handlers.POST(post(token, { "content-type": "application/json" }), token);
    for (const response of [crossSite, noOrigin, json]) expect(response.status).toBe(403);
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R4: a derivative that cannot be read fails the POST with 503 and does not spend the link", async () => {
    const { handlers, token, store } = await fixture({ missing: "rev1--run1--p2-large.webp" }),
      failed = await handlers.POST(post(token), token);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain("try again");
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R4: a story without a manifest answers 410 and stays unused", async () => {
    const { handlers, token, repository, created, store } = await fixture(),
      story = await repository.findStory(created.story.id);
    if (!story) throw new Error("expected the story");
    await repository.saveStory({ ...story, manifest: undefined }, story.version);
    expect((await handlers.POST(post(token), token)).status).toBe(410);
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R4: a photo whose source is not one of this story's own images answers 503 and does not spend the link", async () => {
    const { handlers, token, repository, created, store } = await fixture(),
      story = await repository.findStory(created.story.id);
    if (!story?.manifest) throw new Error("expected a manifest");
    const [first, ...rest] = story.manifest.photos;
    if (!first) throw new Error("expected photos");
    for (const srcLarge of [
      "https://upload.wikimedia.example/photo.jpg",
      "/api/media/other-story/rev1--run1--p1-large.webp",
      `/api/media/${created.story.id}/..%2Fsecret`,
      `/api/media/${created.story.id}/plain.webp`,
    ]) {
      const current = await repository.findStory(created.story.id);
      if (!current) throw new Error("expected the story");
      await repository.saveStory(
        { ...current, manifest: { ...story.manifest, photos: [{ ...first, srcLarge }, ...rest] } },
        current.version
      );
      expect((await handlers.POST(post(token), token)).status, srcLarge).toBe(503);
    }
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R4: two images with the same name from different runs both stay in the ZIP under distinct paths", async () => {
    const { handlers, token, repository, created, files } = await fixture(),
      story = await repository.findStory(created.story.id);
    if (!story?.manifest) throw new Error("expected a manifest");
    files.set("rev1--run2--p1-large.webp", await webp("#ffffff"));
    const [first, ...rest] = story.manifest.photos;
    if (!first) throw new Error("expected photos");
    await repository.saveStory(
      {
        ...story,
        manifest: {
          ...story.manifest,
          photos: [first, { ...rest[0]!, srcLarge: `/api/media/${created.story.id}/rev1--run2--p1-large.webp` }, ...rest.slice(1)],
        },
      },
      story.version
    );
    const zip = readZip(new Uint8Array(await (await handlers.POST(post(token), token)).arrayBuffer())),
      html = zip.get("index.html")?.data.toString("utf8") ?? "";
    expect([...zip.keys()].filter(name => name !== "index.html")).toHaveLength(3);
    for (const reference of localReferences(html)) expect(zip.has(reference), reference).toBe(true);
    expect(new Set(localReferences(html)).size).toBe(3);
  });

  it("BUI-2146 R4: a manifest with no photos answers 410 and stays unused", async () => {
    const { handlers, token, repository, created, store } = await fixture(),
      story = await repository.findStory(created.story.id);
    if (!story?.manifest) throw new Error("expected a manifest");
    await repository.saveStory({ ...story, manifest: { ...story.manifest, photos: [] } }, story.version);
    expect((await handlers.POST(post(token), token)).status).toBe(410);
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2146 R4: two concurrent POSTs give one ZIP and one 410", async () => {
    const { handlers, token } = await fixture(),
      statuses = (await Promise.all([handlers.POST(post(token), token), handlers.POST(post(token), token)])).map(
        response => response.status
      );
    expect(statuses.sort()).toEqual([200, 410]);
  });

  it("BUI-2146 R4: the proxy does not renew or set an owner cookie on the download page", () => {
    const response = proxy(
      new NextRequest(`${origin}/download/abc`, { method: "POST", headers: { cookie: "wanderpage_owner=older-value" } })
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("BUI-2146 R4: the static export removes app/download with the other server-only folders", async () => {
    const script = await readFile("scripts/static-export.ts", "utf8"),
      list = /for \(const serverOnly of \[([\s\S]*?)\]\)/.exec(script)?.[1] ?? "";
    expect(list).toContain('"app/download"');
    expect(list).toContain('"app/upload"');
  });
});
