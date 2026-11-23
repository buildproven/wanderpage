// @design DES-WEB-MCP
// The ZIP `download_page` gives the owner (BUI-2146): `index.html` plus the story's derived images, with relative paths, so the page opens
// from the unzipped folder and can be hosted anywhere. It is built only from the story's manifest and its derived WebP images (already
// without EXIF or GPS, see the processor): never an original upload, a coordinate or a capture time. It shows what the published page shows.
import { crc32, deflateRawSync } from "node:zlib";
import type { TripManifest } from "@/lib/schemas/trip";
import type { Story } from "@/lib/web/types";

/** Reads one derived image of a story by its media file name (`<revision>--<run>--<name>`); undefined when it is not stored. */
export type DerivativeReader = (storyId: string, filename: string) => Promise<Uint8Array | undefined>;

export type ArchiveEntry = { path: string; data: Uint8Array };

/** A story that cannot be archived: its derivatives are missing or its manifest names a file the archive cannot hold. */
export class PageArchiveError extends Error {
  constructor(
    readonly code: "NO_MANIFEST" | "FILE_UNAVAILABLE" | "FILE_NOT_ALLOWED",
    message: string
  ) {
    super(message);
  }
}

const readConcurrency = 4;

/** The story's `index.html` and images as ZIP entries, and the ZIP's file name (the public slug, else the title as a slug). */
export async function buildPageArchive(story: Story, read: DerivativeReader) {
  const manifest = story.manifest;
  if (!manifest) throw new PageArchiveError("NO_MANIFEST", "This story has no page to download yet.");
  const files = new Map<string, string>(), // media file name -> path in the ZIP
    taken = new Set<string>(),
    pathOf = (src: string) => {
      const filename = mediaFilename(story.id, src),
        known = files.get(filename);
      if (known) return known;
      const preferred = filename.split("--").slice(2).join("--"),
        name = preferred && !taken.has(preferred) ? preferred : filename,
        path = `images/${name}`;
      taken.add(name);
      files.set(filename, path);
      return path;
    },
    html = renderPage(manifest, pathOf),
    images = [...files],
    data = new Array<ArchiveEntry>(images.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(readConcurrency, images.length) }, async () => {
      while (next < images.length) {
        const index = next++,
          [filename, path] = images[index]!,
          bytes = await read(story.id, filename);
        if (!bytes) throw new PageArchiveError("FILE_UNAVAILABLE", `A page image is unavailable: ${filename}`);
        data[index] = { path, data: bytes };
      }
    })
  );
  return { fileName: `${archiveSlug(story)}.zip`, entries: [{ path: "index.html", data: new TextEncoder().encode(html) }, ...data] };
}

export function archiveSlug(story: Pick<Story, "publicSlug" | "title">) {
  const slug = (story.publicSlug ?? story.title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "wanderpage-story";
}

/** `/api/media/<storyId>/<file>` of this story, as the processor writes it; any other source is not part of the story's own files. */
function mediaFilename(storyId: string, src: string) {
  const prefix = `/api/media/${storyId}/`;
  if (!src.startsWith(prefix)) throw new PageArchiveError("FILE_NOT_ALLOWED", "A page image is not one of this story's own images.");
  let filename: string;
  try {
    filename = decodeURIComponent(src.slice(prefix.length));
  } catch {
    throw new PageArchiveError("FILE_NOT_ALLOWED", "A page image has an unreadable name.");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(filename) || filename.split("--").length < 3)
    throw new PageArchiveError("FILE_NOT_ALLOWED", "A page image has an unexpected name.");
  return filename;
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (value: string) => value.replace(/[&<>"']/g, character => entities[character] ?? character);
const color = (value: string, fallback: string) => (/^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback);

/** The published page as one self-contained document with no script: the story's own text and its images by relative path. */
function renderPage(trip: TripManifest, pathOf: (src: string) => string) {
  const photos = new Map(trip.photos.map(photo => [photo.id, photo])),
    gallery = trip.photos.filter(photo => photo.source === "user"),
    hero = photos.get(trip.heroPhotoId) ?? gallery[0],
    closing = gallery.at(-1) ?? hero;
  if (!hero || !closing) throw new PageArchiveError("NO_MANIFEST", "This story has no photos to download.");
  const image = (photo: TripManifest["photos"][number], className = "") =>
      `<img${className ? ` class="${className}"` : ""} src="${escape(pathOf(photo.srcLarge))}" alt="${escape(photo.alt)}" width="${photo.width}" height="${photo.height}" loading="${className === "hero-image" ? "eager" : "lazy"}">`,
    destinationName = (id?: string) => trip.destinations.find(item => item.id === id)?.name,
    theme = {
      background: color(trip.theme.background, "#111111"),
      foreground: color(trip.theme.foreground, "#f4efe6"),
      accent: color(trip.theme.accent, "#d96b47"),
      muted: color(trip.theme.muted, "#9a948a"),
    },
    chapters = trip.chapters.map((chapter, index) => {
      const destination = trip.destinations.find(item => item.id === chapter.destinationId),
        chapterPhotos = chapter.photoIds.flatMap(id => photos.get(id) ?? []).slice(0, 2);
      return (
        `<article class="chapter"><header><span class="number">0${index + 1}</span><h2>${escape(chapter.title)}</h2>` +
        `${destination ? `<span class="eyebrow">${escape(destination.name)} / field entry</span>` : ""}` +
        `<p>${escape(chapter.narrative)}</p></header>` +
        `<div class="spread">${chapterPhotos.map(photo => `<figure>${image(photo)}<figcaption>${escape(photo.caption ?? "")}</figcaption></figure>`).join("")}</div>` +
        (destination && destination.facts.length
          ? `<aside class="facts"><span class="eyebrow">Field notes · ${escape(destination.name)}</span>${destination.facts
              .map(fact => `<p><span class="eyebrow">Observed context</span><br>${escape(fact.text)}</p>`)
              .join("")}</aside>`
          : "") +
        "</article>"
      );
    }),
    route = trip.route
      .map(point => destinationName(point.destinationId))
      .filter((name): name is string => Boolean(name))
      .map(name => `<li>${escape(name)}</li>`)
      .join(""),
    dates = trip.dateRange ? `${trip.dateRange.start} — ${trip.dateRange.end}` : "";
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escape(trip.title)} — Wanderpage</title><meta name="description" content="${escape(trip.subtitle)}"><style>${css(theme)}</style></head>` +
    `<body><main><section class="hero">${image(hero, "hero-image")}<div class="hero-copy"><span class="eyebrow">A photographic field note</span>` +
    `<h1>${escape(trip.title)}</h1><p class="meta">${escape(dates)}${dates && trip.destinations.length ? " · " : ""}${escape(trip.destinations.map(d => d.name).join(" · "))}</p></div></section>` +
    `<section class="intro"><span class="eyebrow">The passage</span><blockquote>${escape(trip.opening)}</blockquote></section>` +
    `<section class="stats">${trip.stats.map(stat => `<div><strong>${escape(stat.value)}</strong><span>${escape(stat.label)}</span></div>`).join("")}</section>` +
    (route
      ? `<section class="route"><p>${escape(trip.subtitle)}</p><ol>${route}</ol></section>`
      : `<section class="route"><p>${escape(trip.subtitle)}</p></section>`) +
    chapters.join("") +
    `<section class="gallery"><h2>Frames from the road</h2><p>${gallery.length} photographs, arranged in the order they were made.</p><div class="grid">${gallery
      .map(photo => `<a href="${escape(pathOf(photo.srcLarge))}">${image(photo)}</a>`)
      .join("")}</div></section>` +
    `<section class="closing">${image(closing)}<p>${escape(trip.closing)}</p></section>` +
    `<footer><span class="eyebrow">Sources &amp; credits</span>${trip.sources
      .map(
        source =>
          `<div><a href="${escape(source.url)}" rel="noreferrer">${escape(source.title)}</a> · ${escape(source.provider)}${source.license ? ` · ${escape(source.license)}` : ""}</div>`
      )
      .join(
        ""
      )}<div class="line"><span>Wanderpage</span><span>Private by default · shared by choice</span></div></footer></main></body></html>\n`
  );
}

function css(theme: { background: string; foreground: string; accent: string; muted: string }) {
  return (
    `:root{--bg:${theme.background};--fg:${theme.foreground};--accent:${theme.accent};--muted:${theme.muted}}` +
    "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:Georgia,'Times New Roman',serif;line-height:1.6}" +
    "img{display:block;max-width:100%;height:auto}a{color:var(--accent)}" +
    ".eyebrow{font:600 .75rem system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}" +
    ".hero{position:relative;min-height:90vh;display:flex;align-items:flex-end}.hero .hero-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}" +
    ".hero-copy{position:relative;padding:6vw;background:linear-gradient(transparent,rgba(0,0,0,.7));width:100%}.hero h1{font-size:clamp(2.4rem,7vw,5.5rem);margin:.2em 0;line-height:1.05}" +
    ".meta{color:var(--muted);margin:0}.intro,.route,.gallery,.chapter{max-width:70rem;margin:0 auto;padding:6vw}.intro blockquote{font-size:1.6rem;margin:.5em 0 0}" +
    ".stats{display:flex;flex-wrap:wrap;gap:2rem;max-width:70rem;margin:0 auto;padding:0 6vw}.stats strong{display:block;font-size:2rem}.stats span{color:var(--muted)}" +
    ".route ol{display:flex;flex-wrap:wrap;gap:1rem;list-style:none;padding:0}.route li{border-top:3px solid var(--accent);padding-top:.4rem}" +
    ".chapter .number{color:var(--accent);font:600 1rem system-ui,sans-serif}.chapter h2{font-size:2.2rem;margin:.2em 0}.spread{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1.5rem}" +
    "figure{margin:0}figcaption{color:var(--muted);font-size:.9rem;padding-top:.4rem}.facts{margin-top:1.5rem;border-left:3px solid var(--accent);padding-left:1rem}" +
    ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.6rem}.grid img{width:100%;aspect-ratio:4/3;object-fit:cover}" +
    ".closing{position:relative;min-height:60vh;display:flex;align-items:center;justify-content:center;text-align:center}.closing img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.45}" +
    ".closing p{position:relative;max-width:36rem;font-size:1.6rem;padding:2rem}footer{max-width:70rem;margin:0 auto;padding:6vw;color:var(--muted);font-size:.9rem}" +
    "footer .line{display:flex;justify-content:space-between;gap:1rem;margin-top:2rem;border-top:1px solid var(--muted);padding-top:1rem}" +
    "@media print{.hero{min-height:0}.closing{min-height:0}}"
  );
}

const encoder = new TextEncoder();

/**
 * Encodes entries as a ZIP: `index.html` deflated, images (already compressed WebP) stored, UTF-8 names, no ZIP64 (the archive and each
 * file stay under 4 GiB, which `zipChunks` checks).
 */
export function zipChunks(entries: ArchiveEntry[]): Uint8Array[] {
  const chunks: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path),
      deflated = /\.html?$/.test(entry.path),
      body = deflated ? new Uint8Array(deflateRawSync(entry.data)) : entry.data,
      crc = crc32(entry.data),
      method = deflated ? 8 : 0,
      local = header(30, name.length, 0x04034b50, 20, 0x0800, method, crc, body.length, entry.data.length);
    if (offset + 30 + name.length + body.length > 0xffffffff) throw new Error("The page archive is too large.");
    chunks.push(local, name, body);
    const directory = header(46, name.length, 0x02014b50, 20, 0x0800, method, crc, body.length, entry.data.length, offset);
    central.push(directory, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0),
    end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return [...chunks, ...central, new Uint8Array(end.buffer)];
}

/** A local file header (30 bytes) or a central directory entry (46 bytes), as the ZIP format lays them out. */
function header(
  size: 30 | 46,
  nameLength: number,
  signature: number,
  needed: number,
  flags: number,
  method: number,
  crc: number,
  compressed: number,
  uncompressed: number,
  localOffset = 0
) {
  const view = new DataView(new ArrayBuffer(size)),
    central = size === 46,
    at = central ? 2 : 0; // the central entry has a "version made by" field the local header lacks
  view.setUint32(0, signature, true);
  if (central) view.setUint16(4, needed, true);
  view.setUint16(4 + at, needed, true);
  view.setUint16(6 + at, flags, true);
  view.setUint16(8 + at, method, true);
  // The modification time and date stay 0 (00:00, 1980-01-01): the archive is the same bytes for the same story.
  view.setUint32(14 + at, crc, true);
  view.setUint32(18 + at, compressed, true);
  view.setUint32(22 + at, uncompressed, true);
  view.setUint16(26 + at, nameLength, true);
  if (central) view.setUint32(42, localOffset, true);
  return new Uint8Array(view.buffer);
}
