// @design DES-WEB-MCP
// The page an upload link from `upload_photos` opens (BUI-2095). GET only shows the story title and a Continue button, so a chat or
// messaging link preview cannot use the link. Continue posts the same URL: the link is used in one conditional update, the owner cookie
// is set for 1 hour with a marker that stops the proxy renewing it, and the browser goes to the story's private page.
// BUI-2204: the in-chat photo picker (an MCP App) posts one `text/plain` JSON reservation per photo to the same URL. That reserves the
// photo under the link's owner session without using the link, and answers the signed Vercel Blob PUT the picker sends the bytes with:
// a function request body is capped at 4.5 MB and a photo can be 25 MB, so the bytes go straight to private Blob, as on the story page.
import { neon } from "@neondatabase/serverless";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadConsentText } from "@/lib/consent";
import { apiError } from "@/lib/web/http";
import { NeonStoryRepository, NeonUploadLinkStore } from "@/lib/web/neon-repository";
import { getStoryService } from "@/lib/web/runtime";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";
import { StoryServiceError, type StoryService } from "@/lib/web/story-service";
import type { StoryUpload } from "@/lib/web/types";
import { allowedPhotoTypes, maxPhotoBytes, UploadService } from "@/lib/web/upload-service";
import { escapeHtml, page, pageHeaders, sameOriginForm } from "@/app/api/mcp/_hosted/link-page";
import {
  ownerTtlCookieName,
  ownerTtlLinkValue,
  uploadLinkCookieMaxAge,
  uploadLinkKey,
  UploadLinks,
  type UploadLinkClaims,
} from "@/lib/web/upload-link";

export type PickerPhoto = { storyId: string; originalName: string; contentType: (typeof allowedPhotoTypes)[number]; byteSize: number };

/** What the in-chat picker's reservations need: `UploadService.reserve` and a Blob client token for exactly one reservation. */
export type PickerPhotos = {
  reserve(ownerSecret: string, photo: PickerPhoto): Promise<StoryUpload>;
  /** A Vercel Blob client token for the reservation's path, type and size, whose completion callback is `callbackUrl`. */
  sign(upload: StoryUpload, callbackUrl: string): Promise<string>;
};

export type UploadLinkDependencies = {
  stories: Pick<StoryService, "getOwnedStory">;
  links: Pick<UploadLinks, "open" | "use">;
  /** The picker's reservations; without it a picker request answers 503. */
  photos?: PickerPhotos;
};

const noLongerValid = "This upload link is no longer valid.";
/** How long a picker's signed Blob PUT can be sent, as the story page's client tokens. */
const pickerPutLifetimeMs = 15 * 60 * 1000;
/** `BLOB_API_VERSION` of the installed @vercel/blob client, which the picker's PUT sends as `x-api-version`. */
export const blobApiVersion = "12";

export function createUploadLinkHandlers(dependencies: () => UploadLinkDependencies) {
  return {
    async GET(_request: Request, token: string) {
      const { stories, links } = dependencies(),
        found = await ownedLink(stories, links, token);
      if (!found) return gone();
      return page(
        200,
        "Add photos",
        `<p class="kicker">Private upload</p><h1>${escapeHtml(found.title)}</h1>` +
          "<p>Continue to this story's private page in this browser, then pick the photos to upload. The link works once.</p>" +
          `<form method="post" action="/upload/${token}"><button type="submit">Continue</button></form>`
      );
    },

    async POST(request: Request, token: string) {
      if (pickerRequest(request)) return pickerReservation(request, token, dependencies());
      if (!sameOriginForm(request)) return page(403, "Request refused", "<h1>This request could not be verified.</h1>");
      const { stories, links } = dependencies(),
        found = await ownedLink(stories, links, token);
      if (!found || !(await links.use(found.claims))) return gone();
      const response = NextResponse.redirect(new URL(`/stories/${found.claims.storyId}`, request.url), 303),
        options = { ...ownerCookieOptions(), maxAge: uploadLinkCookieMaxAge };
      response.cookies.set(ownerCookieName, found.claims.ownerSecret, options);
      response.cookies.set(ownerTtlCookieName, ownerTtlLinkValue, options);
      for (const [name, value] of Object.entries(pageHeaders)) response.headers.set(name, value);
      return response;
    },
  };
}

/**
 * Production wiring: the hosted StoryService, Neon `upload_links` under the session pepper's upload-link key, and the picker's
 * reservations through `UploadService` with client tokens signed by `BLOB_READ_WRITE_TOKEN`.
 */
export function uploadLinkDependencies(): UploadLinkDependencies {
  const url = process.env.DATABASE_URL?.trim(),
    pepper = process.env.WANDERPAGE_SESSION_PEPPER?.trim();
  if (!url || !pepper) throw new Error("DATABASE_URL and WANDERPAGE_SESSION_PEPPER are required for upload links.");
  const stories = getStoryService();
  return {
    stories,
    links: new UploadLinks({ store: new NeonUploadLinkStore(neon(url)), key: uploadLinkKey(pepper) }),
    photos: {
      reserve: (ownerSecret, photo) => new UploadService(NeonStoryRepository.fromEnvironment(), stories).reserve(ownerSecret, photo),
      sign: (upload, callbackUrl) => {
        const readWrite = process.env.BLOB_READ_WRITE_TOKEN?.trim();
        if (!readWrite) throw new Error("BLOB_READ_WRITE_TOKEN is required for private uploads.");
        return photoUploadSigner(readWrite)(upload, callbackUrl);
      },
    },
  };
}

/** Signs a client token that lets one PUT store exactly this reservation, then calls `callbackUrl`, which confirms it. */
export function photoUploadSigner(readWrite: string): PickerPhotos["sign"] {
  return (upload, callbackUrl) =>
    generateClientTokenFromReadWriteToken({
      token: readWrite,
      pathname: upload.blobPath,
      allowedContentTypes: [upload.declaredType],
      maximumSizeInBytes: upload.byteSize ?? maxPhotoBytes,
      validUntil: Date.now() + pickerPutLifetimeMs,
      addRandomSuffix: false,
      allowOverwrite: false,
      onUploadCompleted: { callbackUrl, tokenPayload: JSON.stringify({ uploadId: upload.id, storyId: upload.storyId }) },
    });
}

/** The Vercel Blob API base the picker PUTs to: `VERCEL_BLOB_API_URL` when set, as the Blob client reads it. */
export function blobApiUrl() {
  return (process.env.VERCEL_BLOB_API_URL?.trim() || "https://vercel.com/api/blob").replace(/\/+$/, "");
}

/** The PUT the @vercel/blob client `upload()` sends for a private photo, with the client token of that one reservation. */
export function blobPut(upload: StoryUpload, clientToken: string) {
  const storeId = clientToken.split("_")[3];
  if (!clientToken.startsWith("vercel_blob_client_") || !storeId) throw new Error("The Blob client token is malformed.");
  return {
    method: "PUT" as const,
    url: `${blobApiUrl()}/?${new URLSearchParams({ pathname: upload.blobPath })}`,
    headers: {
      authorization: `Bearer ${clientToken}`,
      "x-api-version": blobApiVersion,
      "x-vercel-blob-store-id": storeId,
      "x-vercel-blob-access": "private",
      "x-content-type": upload.declaredType,
      ...(upload.byteSize === undefined ? {} : { "x-content-length": String(upload.byteSize) }),
    },
  };
}

const pickerInput = z.strictObject({
  originalName: z.string().trim().min(1).max(255),
  contentType: z.enum(allowedPhotoTypes),
  byteSize: z.number().int().positive().max(maxPhotoBytes),
});

/**
 * A picker request is a CORS simple request (`text/plain`, no custom header), so the sandboxed MCP App needs no preflight. The link page's
 * forms are `application/x-www-form-urlencoded`, so the two never meet.
 */
function pickerRequest(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/plain";
}

/**
 * Reserves one photo for the link's story and answers its signed Blob PUT. The link stays unused, so the browser link still works as the
 * fallback; the token, which only the owner's chat holds, is the credential, and every reservation keeps UploadService's limits.
 */
async function pickerReservation(request: Request, token: string, { links, photos }: UploadLinkDependencies) {
  if (!photos)
    return pickerError(503, "CONFIGURATION_ERROR", "The in-chat picker is not configured. Open the upload link in your browser.");
  const opened = await links.open(token);
  if (!opened.ok) return pickerGone();
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return pickerError(400, "VALIDATION_ERROR", "The request body must be valid JSON.");
  }
  const parsed = pickerInput.safeParse(body);
  if (!parsed.success)
    return pickerError(
      400,
      "VALIDATION_ERROR",
      `Each photo must be a JPEG, PNG or WebP file of at most ${maxPhotoBytes / 1024 / 1024} MiB with a file name.`
    );
  try {
    const upload = await photos.reserve(opened.claims.ownerSecret, { ...parsed.data, storyId: opened.claims.storyId }),
      clientToken = await photos.sign(upload, `${new URL(request.url).origin}/api/uploads`);
    return pickerJson(201, { data: { uploadId: upload.id, put: blobPut(upload, clientToken) } });
  } catch (error) {
    if (error instanceof StoryServiceError && ["AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)) return pickerGone();
    const answer = apiError(error);
    return pickerJson(answer.status, await answer.json());
  }
}

/** Picker answers are readable from the sandboxed app's origin; they carry no cookie and need the token to get. */
function pickerJson(status: number, body: unknown) {
  return Response.json(body, {
    status,
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
  });
}

function pickerError(status: number, code: string, message: string) {
  return pickerJson(status, { error: { code, message } });
}

function pickerGone() {
  return pickerError(410, "LINK_GONE", `${noLongerValid} Ask Claude for a new upload link: upload links expire after 15 minutes.`);
}

/** The opened link and its story title, or undefined when the link, its story or its owner session is no longer valid. */
async function ownedLink(
  stories: UploadLinkDependencies["stories"],
  links: UploadLinkDependencies["links"],
  token: string
): Promise<{ claims: UploadLinkClaims; title: string } | undefined> {
  const opened = await links.open(token);
  if (!opened.ok) return undefined;
  try {
    const story = await stories.getOwnedStory(opened.claims.ownerSecret, opened.claims.storyId);
    return { claims: opened.claims, title: story.title };
  } catch (error) {
    if (error instanceof StoryServiceError && ["AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)) return undefined;
    throw error;
  }
}

function gone() {
  return page(
    410,
    "Link no longer valid",
    `<h1>${noLongerValid}</h1><p>Ask Claude for a new upload link: upload links work once and expire after 15 minutes.</p>`
  );
}

/** The MCP App (SEP-1865) that `upload_photos` names: an in-chat photo picker for the story the tool result's `uploadUrl` opens. */
export const uploadPickerUri = "ui://wanderpage/upload-photos.html";
export const uploadPickerMimeType = "text/html;profile=mcp-app";

/** The picker's `_meta.ui`: it may connect only to this deployment (reservations) and the Blob API (the photo bytes). */
export function uploadPickerMeta(publicOrigin: string | undefined) {
  const connectDomains = [publicOrigin, new URL(blobApiUrl()).origin].filter((origin): origin is string => Boolean(origin));
  return { ui: { csp: { connectDomains, resourceDomains: [] }, prefersBorder: true } };
}

/**
 * The picker's HTML. The `ui://` template holds no story data: the host sends the tool result (`ui/notifications/tool-result`), whose
 * `uploadUrl` the picker posts each photo's reservation to before it PUTs the bytes. The copy embedded in one `upload_photos` result
 * carries that call's `uploadUrl`. The link stays on screen, so the owner can always use the browser.
 */
export function uploadPickerHtml(uploadUrl?: string) {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Add photos · Wanderpage</title><style>` +
    "body{font-family:system-ui,sans-serif;margin:0;padding:1rem 1.25rem;background:#f7f4ee;color:#1d1b18}" +
    ".kicker{text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;color:#6b645a;margin:0}h1{font-size:1.25rem;margin:.25rem 0}" +
    "p{margin:.5rem 0;line-height:1.4}.consent{font-size:.85rem;color:#4a443c}label{display:block;font-weight:600;margin-top:.75rem}" +
    "input{margin:.5rem 0;font:inherit}ul{list-style:none;padding:0;margin:.5rem 0}li{display:flex;justify-content:space-between;gap:1rem;" +
    "padding:.25rem 0;border-bottom:1px solid #e4ddd1;font-size:.9rem}li span:first-child{overflow-wrap:anywhere}" +
    "code{overflow-wrap:anywhere;font-size:.8rem}a{color:inherit}" +
    "progress{width:6rem}" +
    `</style></head><body><main${uploadUrl ? ` data-upload-url="${escapeHtml(uploadUrl)}"` : ""}>` +
    `<p class="kicker">Private upload</p><h1>Add photos</h1>` +
    "<p>JPEG, PNG or WebP; 6 to 60 photos in total. Your photos stay private until you publish a finished draft.</p>" +
    `<p class="consent" id="consent">${escapeHtml(uploadConsentText)}</p>` +
    `<label for="photos">Photos</label><input id="photos" type="file" accept="image/*" multiple disabled>` +
    `<p id="status" role="status" aria-live="polite">Waiting for the upload link…</p><ul id="files"></ul>` +
    `<p id="fallback" hidden>If the picker does not work here, <a id="link" href="#" target="_blank" rel="noopener noreferrer">open the ` +
    `upload page in your browser</a>: <code id="address"></code></p>` +
    `</main><script>${pickerScript}</script></body></html>`
  );
}

// Plain ES2017 with no import: the host's default CSP allows inline script and only the declared connect domains.
const pickerScript = `
(function () {
  "use strict";
  var input = document.getElementById("photos"), status = document.getElementById("status"), list = document.getElementById("files"),
    fallback = document.getElementById("fallback"), link = document.getElementById("link"), address = document.getElementById("address");
  var uploadUrl = null, nextId = 1, pending = {};
  var linkPattern = /^https?:\\/\\/[^\\/?#]+\\/upload\\/[^\\/?#]+$/;

  function send(message) { window.parent.postMessage(message, "*"); }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function resize() {
    notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }

  /** The tool result's uploadUrl: structuredContent first, then the JSON text the tool also returns. */
  function linkOf(result) {
    if (result && result.structuredContent && typeof result.structuredContent.uploadUrl === "string") return result.structuredContent.uploadUrl;
    var blocks = (result && result.content) || [];
    for (var i = 0; i < blocks.length; i++) {
      if (!blocks[i] || typeof blocks[i].text !== "string") continue;
      try {
        var parsed = JSON.parse(blocks[i].text);
        if (parsed && typeof parsed.uploadUrl === "string") return parsed.uploadUrl;
      } catch (error) {
        // Not JSON: a plain text block carries no link.
      }
    }
    return null;
  }

  function received(params) {
    var result = params && params.result && !params.content && !params.structuredContent ? params.result : params,
      url = result && !result.isError ? linkOf(result) : null;
    if (typeof url !== "string" || !linkPattern.test(url)) {
      var text = result && result.content && result.content[0] && result.content[0].text;
      status.textContent = typeof text === "string" && result.isError ? text : "This tool result has no upload link. Ask Claude for a new one.";
      resize();
      return;
    }
    activate(url);
  }

  function activate(url) {
    uploadUrl = url;
    link.href = url;
    address.textContent = url;
    fallback.hidden = false;
    input.disabled = false;
    status.textContent = "Pick the photos for this story.";
    resize();
  }

  window.addEventListener("message", function (event) {
    // The host's frame, or no source at all; never another window.
    if (event.source && event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (!data.method && data.id !== undefined && pending[data.id]) {
      var waiting = pending[data.id];
      delete pending[data.id];
      if (data.error) waiting.reject(new Error(data.error.message || "The host refused the request."));
      else waiting.resolve(data.result);
      return;
    }
    if (data.method === "ui/notifications/tool-result") received(data.params);
    else if (data.method === "ui/resource-teardown" && data.id !== undefined) send({ jsonrpc: "2.0", id: data.id, result: {} });
  });

  function refusal(response) {
    return response.json().then(
      function (body) {
        if (response.ok && body && body.data && body.data.put) return body.data.put;
        throw new Error((body && body.error && body.error.message) || "Wanderpage refused this photo (" + response.status + ").");
      },
      function () { throw new Error("Wanderpage answered " + response.status + "."); }
    );
  }

  function store(put, file, state) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(put.method, put.url);
      Object.keys(put.headers).forEach(function (name) { xhr.setRequestHeader(name, put.headers[name]); });
      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable || !(event.total > 0)) return;
        var percent = Math.round((event.loaded / event.total) * 100);
        state.textContent = percent + "%";
        state.bar.value = percent;
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          state.bar.value = 100;
          resolve();
        }
        else reject(new Error("The photo store refused this photo (" + xhr.status + ")."));
      };
      xhr.onerror = function () { reject(new Error("The upload could not reach the photo store.")); };
      xhr.send(file);
    });
  }

  function uploadOne(file, state) {
    state.textContent = "Reserving…";
    return fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ originalName: file.name, contentType: file.type, byteSize: file.size })
    }).then(refusal).then(function (put) {
      state.textContent = "0%";
      return store(put, file, state);
    });
  }

  input.addEventListener("change", function () {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = "";
    if (!files.length || !uploadUrl) return;
    input.disabled = true;
    while (list.firstChild) list.removeChild(list.firstChild);
    var states = files.map(function (file) {
      var row = document.createElement("li"), name = document.createElement("span"), state = document.createElement("span"),
        bar = document.createElement("progress");
      name.textContent = file.name;
      state.textContent = "Waiting";
      bar.max = 100;
      bar.value = 0;
      bar.setAttribute("aria-label", file.name + " upload progress");
      state.bar = bar;
      row.appendChild(name);
      row.appendChild(bar);
      row.appendChild(state);
      list.appendChild(row);
      return state;
    });
    var accepted = 0, failed = 0, index = 0;
    status.textContent = "Uploading " + files.length + (files.length === 1 ? " photo…" : " photos…");
    resize();
    function next() {
      if (index >= files.length) {
        status.textContent = accepted + " of " + files.length + " photos accepted." +
          (failed ? " Pick the others again, or open the upload page in your browser." : " Ask Claude to start generation when all are in.");
        input.disabled = false;
        resize();
        return;
      }
      var position = index++, state = states[position];
      uploadOne(files[position], state).then(
        function () { accepted++; state.textContent = "Accepted"; },
        function (error) { failed++; state.textContent = error.message; }
      ).then(next);
    }
    next();
  });

  link.addEventListener("click", function (event) {
    event.preventDefault();
    if (!uploadUrl) return;
    request("ui/open-link", { url: uploadUrl }).catch(function () {
      status.textContent = "Copy the link above into your browser.";
    });
  });

  var embedded = document.querySelector("main").getAttribute("data-upload-url");
  if (embedded && linkPattern.test(embedded)) activate(embedded);

  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(document.body);
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "wanderpage-upload", version: "1.0.0" },
    clientInfo: { name: "wanderpage-upload", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] }
  }).then(function () { notify("ui/notifications/initialized", {}); resize(); }, function () {
    status.textContent = "This chat could not start the picker. Open the upload link in Claude's reply in your browser.";
  });
})();
`;
