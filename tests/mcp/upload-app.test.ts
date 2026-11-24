import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { getPayloadFromClientToken } from "@vercel/blob/client";
import { describe, expect, it, vi } from "vitest";
import { currentDisclosureVersion, uploadConsentText } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import { MemoryUploadLinkStore, uploadLinkKey, UploadLinks } from "@/lib/web/upload-link";
import { UploadService } from "@/lib/web/upload-service";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";
import {
  blobApiVersion,
  createUploadLinkHandlers,
  photoUploadSigner,
  uploadPickerHtml,
  uploadPickerMimeType,
  uploadPickerUri,
  type PickerPhotos,
} from "@/app/api/mcp/_hosted/upload-page";

const owner = "owner-login",
  origin = "https://trips.example.com",
  pepper = ["upload", "app", "test", "pepper", "value", "long", "enough"].join("-"),
  // A Blob read-write credential has the shape vercel_blob_rw_<store>_<secret>; this one is built from parts and signs nothing real.
  blobReadWrite = ["vercel", "blob", "rw", "teststore", "signing", "part", "for", "tests"].join("_"),
  storyInput = {
    title: "Kyoto in autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

function services() {
  const repository = new MemoryStoryRepository(),
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit: 25 })
    ),
    store = new MemoryUploadLinkStore(),
    links = new UploadLinks({ store, key: uploadLinkKey(pepper) });
  return { repository, stories, store, links };
}

async function mcpFixture() {
  const { repository, stories, store, links } = services(),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    server = createHostedServer({ stories, sessions, subject: owner, ownerSubject: owner, publicOrigin: origin, uploadLinks: links }),
    client = new Client({ name: "upload-app-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const story = await stories.createStory(await sessions.secretFor(owner), storyInput);
  return { repository, store, client, story };
}

async function routeFixture(photos?: PickerPhotos | "real") {
  const { repository, stories, store, links } = services(),
    created = await stories.createSessionWithStory(storyInput, "client"),
    real: PickerPhotos = {
      reserve: (secret, photo) => new UploadService(repository, stories).reserve(secret, photo),
      sign: photoUploadSigner(blobReadWrite),
    },
    handlers = createUploadLinkHandlers(() => ({ stories, links, photos: photos === "real" ? real : photos })),
    issued = await links.issue(created.story.id, created.rawSecret);
  return { repository, store, links, handlers, created, linkValue: issued.token };
}

const reservation = (linkValue: string, body: unknown, contentType = "text/plain;charset=UTF-8") =>
  new Request(`${origin}/upload/${linkValue}`, {
    method: "POST",
    headers: { origin: "null", "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const photo = { originalName: "temple.jpg", contentType: "image/jpeg", byteSize: 2048 };

// jsdom ships no type declarations; this names only the surface the picker tests use.
type PickerWindow = Window & typeof globalThis;
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options: { runScripts: "dangerously"; url: string; beforeParse(window: PickerWindow): void }
  ) => { window: PickerWindow };
};

class FakeUpload {
  static sent: FakeUpload[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    FakeUpload.sent.push(this);
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
}

type Posted = { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown> };

function picker(fetchMock: (url: string, init: RequestInit) => Promise<Response>, html = uploadPickerHtml()) {
  FakeUpload.sent = [];
  const posted: Posted[] = [],
    { window } = new JSDOM(html, {
      runScripts: "dangerously",
      url: "https://sandbox.example/",
      beforeParse(target) {
        Object.assign(target, { fetch: fetchMock, XMLHttpRequest: FakeUpload, postMessage: (message: Posted) => posted.push(message) });
      },
    }),
    element = (id: string) => window.document.getElementById(id) as HTMLElement,
    deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window })),
    pick = (files: File[]) => {
      const input = element("photos") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(new window.Event("change"));
    };
  return { window, posted, element, deliver, pick };
}

const uploadUrl = `${origin}/upload/sealed-link-value_1`;
const toolResult = (structuredContent: Record<string, unknown>, isError = false) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/tool-result",
  params: { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, ...(isError ? { isError } : {}) },
});
const signedPut = (name: string) =>
  Response.json(
    {
      data: {
        uploadId: `upload-${name}`,
        put: { method: "PUT", url: `https://vercel.com/api/blob/?pathname=sources%2F${name}`, headers: { "x-content-type": "image/jpeg" } },
      },
    },
    { status: 201 }
  );

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01, REQ-WEB-03
describe("upload_photos in-chat photo picker (BUI-2204)", () => {
  it("BUI-2204 R1: upload_photos names the ui:// picker on the tool and the result, and still returns the upload link", async () => {
    const { client, story } = await mcpFixture(),
      { tools } = await client.listTools(),
      tool = tools.find(entry => entry.name === "upload_photos");
    expect(uploadPickerUri).toMatch(/^ui:\/\//);
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: uploadPickerUri } });
    const result = await client.callTool({ name: "upload_photos", arguments: { storyId: story.id } }),
      data = result.structuredContent as { uploadUrl: string };
    expect(result.isError).not.toBe(true);
    expect(result._meta).toMatchObject({ ui: { resourceUri: uploadPickerUri } });
    expect(data.uploadUrl).toMatch(/^https:\/\/trips\.example\.com\/upload\/[A-Za-z0-9_-]+$/);
  });

  it("BUI-2204 R1: the ui:// resource is an MCP App with a multiple image file input and the consent text from lib/consent.ts", async () => {
    const { client } = await mcpFixture(),
      { resources } = await client.listResources();
    expect(resources).toContainEqual(expect.objectContaining({ uri: uploadPickerUri, mimeType: "text/html;profile=mcp-app" }));
    const { contents } = await client.readResource({ uri: uploadPickerUri }),
      content = contents[0] as { uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> };
    expect(content.mimeType).toBe(uploadPickerMimeType);
    expect(content.text).toMatch(/<input id="photos" type="file" accept="image\/\*" multiple[ >]/);
    expect(content.text).toContain(uploadConsentText);
    expect(content._meta).toEqual({
      ui: { csp: { connectDomains: [origin, "https://vercel.com"], resourceDomains: [] }, prefersBorder: true },
    });
  });

  it("BUI-2204 R2: the app script posts each selected file to the story's upload URL with the token, and PUTs its bytes", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => signedPut(JSON.parse(String(init.body)).originalName)),
      app = picker(fetchMock);
    app.deliver(toolResult({ storyId: "story", uploadUrl, expiresAt: "2026-11-24T10:15:00.000Z" }));
    expect((app.element("photos") as HTMLInputElement).disabled).toBe(false);
    const files = [
      new app.window.File(["abc"], "one.jpg", { type: "image/jpeg" }),
      new app.window.File(["defg"], "two.png", { type: "image/png" }),
    ];
    app.pick(files);
    await vi.waitFor(() => expect(FakeUpload.sent).toHaveLength(1));
    expect(fetchMock).toHaveBeenNthCalledWith(1, uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ originalName: "one.jpg", contentType: "image/jpeg", byteSize: 3 }),
    });
    const first = FakeUpload.sent[0]!;
    expect(first.method).toBe("PUT");
    expect(first.url).toBe("https://vercel.com/api/blob/?pathname=sources%2Fone.jpg");
    expect(first.headers).toEqual({ "x-content-type": "image/jpeg" });
    expect(first.body).toBe(files[0]);
    first.progress(1, 2);
    const rows = () => [...app.window.document.querySelectorAll("#files li")].map(row => row.textContent);
    expect(rows()).toEqual(["one.jpg50%", "two.pngWaiting"]);
    first.finish(200);
    await vi.waitFor(() => expect(FakeUpload.sent).toHaveLength(2));
    expect(fetchMock).toHaveBeenNthCalledWith(2, uploadUrl, expect.objectContaining({ body: expect.stringContaining('"byteSize":4') }));
    FakeUpload.sent[1]!.finish(200);
    await vi.waitFor(() => expect(app.element("status").textContent).toContain("2 of 2 photos accepted."));
    expect(rows()).toEqual(["one.jpgAccepted", "two.pngAccepted"]);
  });

  it("BUI-2204 R2: a refused photo shows the server's message and the count of the photos accepted", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
        JSON.parse(String(init.body)).originalName === "bad.heic"
          ? Response.json({ error: { message: "Each photo must be a JPEG, PNG or WebP file." } }, { status: 400 })
          : signedPut("good.jpg")
      ),
      app = picker(fetchMock);
    app.deliver(toolResult({ storyId: "story", uploadUrl }));
    app.pick([
      new app.window.File(["x"], "bad.heic", { type: "image/heic" }),
      new app.window.File(["y"], "good.jpg", { type: "image/jpeg" }),
    ]);
    await vi.waitFor(() => expect(FakeUpload.sent).toHaveLength(1));
    FakeUpload.sent[0]!.finish(200);
    await vi.waitFor(() => expect(app.element("status").textContent).toContain("1 of 2 photos accepted."));
    expect(app.window.document.querySelector("#files li")?.textContent).toContain("Each photo must be a JPEG, PNG or WebP file.");
  });

  it("BUI-2204 R2: a PUT the photo store refuses or cannot reach counts as not accepted", async () => {
    const app = picker(vi.fn(async () => signedPut("any.jpg")));
    app.deliver(toolResult({ storyId: "story", uploadUrl }));
    app.pick([new app.window.File(["a"], "a.jpg", { type: "image/jpeg" }), new app.window.File(["b"], "b.jpg", { type: "image/jpeg" })]);
    await vi.waitFor(() => expect(FakeUpload.sent).toHaveLength(1));
    FakeUpload.sent[0]!.finish(403);
    await vi.waitFor(() => expect(FakeUpload.sent).toHaveLength(2));
    FakeUpload.sent[1]!.onerror?.();
    await vi.waitFor(() => expect(app.element("status").textContent).toContain("0 of 2 photos accepted."));
    expect([...app.window.document.querySelectorAll("#files li")].map(row => row.textContent)).toEqual([
      "a.jpgThe photo store refused this photo (403).",
      "b.jpgThe upload could not reach the photo store.",
    ]);
  });

  it("BUI-2204 R2: the app starts with ui/initialize and then sends ui/notifications/initialized", async () => {
    const app = picker(vi.fn());
    const initialize = app.posted.find(message => message.method === "ui/initialize");
    expect(initialize).toMatchObject({ jsonrpc: "2.0", params: { protocolVersion: "2026-01-26", appCapabilities: {} } });
    app.deliver({ jsonrpc: "2.0", id: initialize?.id, result: { protocolVersion: "2026-01-26", hostCapabilities: {} } });
    await vi.waitFor(() => expect(app.posted.map(message => message.method)).toContain("ui/notifications/initialized"));
  });

  it("BUI-2204 R2: a reservation reserves the photo under the link, leaves the link unused and answers a PUT scoped to it", async () => {
    const { repository, store, handlers, created, linkValue } = await routeFixture("real"),
      before = Date.now(),
      response = await handlers.POST(reservation(linkValue, photo), linkValue);
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    const { data } = (await response.json()) as {
        data: { uploadId: string; put: { method: string; url: string; headers: Record<string, string> } };
      },
      uploads = await repository.listUploads(created.story.id);
    expect(uploads).toEqual([
      expect.objectContaining({ id: data.uploadId, originalName: "temple.jpg", status: "reserved", byteSize: 2048 }),
    ]);
    const blobPath = uploads[0]!.blobPath,
      clientToken = data.put.headers.authorization!.replace(/^Bearer /, "");
    expect(data.put.method).toBe("PUT");
    expect(data.put.url).toBe(`https://vercel.com/api/blob/?pathname=${encodeURIComponent(blobPath)}`);
    expect(data.put.headers).toEqual({
      authorization: `Bearer ${clientToken}`,
      "x-api-version": blobApiVersion,
      "x-vercel-blob-store-id": "teststore",
      "x-vercel-blob-access": "private",
      "x-content-type": "image/jpeg",
      "x-content-length": "2048",
    });
    expect(getPayloadFromClientToken(clientToken)).toMatchObject({
      pathname: blobPath,
      allowedContentTypes: ["image/jpeg"],
      maximumSizeInBytes: 2048,
      addRandomSuffix: false,
      allowOverwrite: false,
      onUploadCompleted: {
        callbackUrl: `${origin}/api/uploads`,
        tokenPayload: JSON.stringify({ uploadId: data.uploadId, storyId: created.story.id }),
      },
    });
    const { validUntil } = getPayloadFromClientToken(clientToken);
    expect(validUntil).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(validUntil).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2204 R2: the PUT headers match the installed @vercel/blob client's API version", async () => {
    const dist = join(process.cwd(), "node_modules/@vercel/blob/dist"),
      sources = await Promise.all(
        (await readdir(dist)).filter(name => name.endsWith(".js")).map(name => readFile(join(dist, name), "utf8"))
      ),
      versions = sources.flatMap(source => [...source.matchAll(/var BLOB_API_VERSION = (\d+);/g)].map(match => match[1]));
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([blobApiVersion]));
  });

  it("BUI-2204 R2: a reservation refuses a bad body, an unsupported type and an oversized photo, and reserves nothing", async () => {
    const { repository, handlers, created, linkValue } = await routeFixture("real");
    for (const body of [
      "not json",
      { ...photo, contentType: "image/heic" },
      { ...photo, byteSize: 26 * 1024 * 1024 },
      { ...photo, extra: 1 },
    ]) {
      const response = await handlers.POST(reservation(linkValue, body), linkValue);
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/JSON|JPEG, PNG or WebP/);
    }
    expect(await repository.listUploads(created.story.id)).toEqual([]);
  });

  it("BUI-2204 R2: a forged, used or expired link, or a deleted story, answers 410 and reserves nothing", async () => {
    const { repository, links, handlers, created, linkValue } = await routeFixture("real"),
      forged = await handlers.POST(reservation(`${linkValue}x`, photo), `${linkValue}x`);
    expect(forged.status).toBe(410);
    expect(forged.headers.get("access-control-allow-origin")).toBe("*");
    const opened = await links.open(linkValue);
    if (!opened.ok) throw new Error("the fixture link should open");
    await links.use(opened.claims);
    expect((await handlers.POST(reservation(linkValue, photo), linkValue)).status).toBe(410);
    expect(await repository.listUploads(created.story.id)).toEqual([]);

    const fresh = await routeFixture("real");
    await fresh.repository.saveStory({ ...fresh.created.story, status: "deleted", deletedAt: new Date() }, fresh.created.story.version);
    expect((await fresh.handlers.POST(reservation(fresh.linkValue, photo), fresh.linkValue)).status).toBe(410);
  });

  it("BUI-2204 R2: a story that is no longer uploading refuses the photo by name", async () => {
    const { repository, handlers, created, linkValue } = await routeFixture("real");
    await repository.saveStory({ ...created.story, status: "queued" }, created.story.version);
    const response = await handlers.POST(reservation(linkValue, photo), linkValue);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("before generation starts");
  });

  it("BUI-2204 R2: without picker wiring a reservation answers 503 and points to the browser link", async () => {
    const { handlers, linkValue } = await routeFixture(),
      response = await handlers.POST(reservation(linkValue, photo), linkValue);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("browser");
  });

  it("BUI-2204 R2: a failed Blob signature answers 503 or 500 and leaves the link unused", async () => {
    const { store, handlers, linkValue } = await routeFixture({
        reserve: async (_secret, input) => ({
          id: "11111111-1111-4111-8111-111111111111",
          storyId: input.storyId,
          blobPath: `sources/${input.storyId}/photo`,
          originalName: input.originalName,
          declaredType: input.contentType,
          byteSize: input.byteSize,
          status: "reserved",
          createdAt: new Date(),
        }),
        sign: async () => {
          throw new Error("BLOB_READ_WRITE_TOKEN is required for private uploads.");
        },
      }),
      response = await handlers.POST(reservation(linkValue, photo), linkValue);
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2204 R3: the tool result's text names the upload link, so a host without MCP Apps still shows it", async () => {
    const { client, story } = await mcpFixture(),
      result = await client.callTool({ name: "upload_photos", arguments: { storyId: story.id } }),
      text = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(text?.type).toBe("text");
    expect(text?.text).toContain((result.structuredContent as { uploadUrl: string }).uploadUrl);
  });

  it("BUI-2204 R3: the picker shows the upload link and opens it in the browser through ui/open-link", async () => {
    const app = picker(vi.fn());
    expect(app.element("fallback").hidden).toBe(true);
    app.deliver(toolResult({ storyId: "story", uploadUrl }));
    expect(app.element("fallback").hidden).toBe(false);
    expect(app.element("address").textContent).toBe(uploadUrl);
    app.element("link").dispatchEvent(new app.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(app.posted).toContainEqual(expect.objectContaining({ method: "ui/open-link", params: { url: uploadUrl } }));
  });

  it("BUI-2204 R3: a tool error or a result without a link keeps the file input off and says why", async () => {
    const refused = picker(vi.fn());
    refused.deliver(toolResult({ storyId: "story", status: "queued" }, true));
    expect((refused.element("photos") as HTMLInputElement).disabled).toBe(true);
    expect(refused.element("status").textContent).toContain("queued");
    const empty = picker(vi.fn());
    empty.deliver(toolResult({ storyId: "story", uploadUrl: "javascript:alert(1)" }));
    expect((empty.element("photos") as HTMLInputElement).disabled).toBe(true);
    expect(empty.element("status").textContent).toContain("no upload link");
  });

  it("BUI-2204 R1: the picker HTML holds no story data or link; the tool result brings them", () => {
    const html = uploadPickerHtml();
    expect(html).not.toContain("/upload/");
    expect(html).toContain('<meta charset="utf-8">');
  });

  it("BUI-2204 R1: the result embeds the picker for this call, with its upload link, as a ui:// resource", async () => {
    const { client, story } = await mcpFixture(),
      result = await client.callTool({ name: "upload_photos", arguments: { storyId: story.id } }),
      { uploadUrl: link } = result.structuredContent as { uploadUrl: string },
      embedded = (result.content as Array<{ type: string; resource?: { uri: string; mimeType: string; text: string } }>).find(
        block => block.type === "resource"
      );
    expect(embedded?.resource?.uri).toBe(uploadPickerUri);
    expect(embedded?.resource?.mimeType).toBe(uploadPickerMimeType);
    expect(embedded?.resource?.text).toContain(`data-upload-url="${link}"`);
    expect(embedded?.resource?.text).toContain(uploadConsentText);
    expect(embedded?.resource?.text).toMatch(/type="file" accept="image\/\*" multiple/);
  });

  it("BUI-2204 R2: the embedded picker posts the selected files to its own upload link with no host message", async () => {
    const fetchMock = vi.fn(async () => signedPut("one.jpg")),
      app = picker(fetchMock, uploadPickerHtml(uploadUrl));
    expect((app.element("photos") as HTMLInputElement).disabled).toBe(false);
    expect(app.element("address").textContent).toBe(uploadUrl);
    app.pick([new app.window.File(["abc"], "one.jpg", { type: "image/jpeg" })]);
    await vi.waitFor(() => expect(FakeUpload.sent).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(uploadUrl, expect.objectContaining({ method: "POST" }));
  });

  it("BUI-2204 R2: a tool result posted with no message source, and with the link only in its JSON text, still opens the picker", async () => {
    const app = picker(vi.fn());
    // jsdom's window.postMessage, like a host proxy in some setups, fires the event with no source.
    app.window.dispatchEvent(
      new app.window.MessageEvent("message", {
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [{ type: "text", text: JSON.stringify({ storyId: "story", uploadUrl }) }] },
        },
      })
    );
    await vi.waitFor(() => expect((app.element("photos") as HTMLInputElement).disabled).toBe(false));
    expect(app.element("address").textContent).toBe(uploadUrl);
  });

  it("BUI-2204 R2: a message from another window is ignored", () => {
    const app = picker(vi.fn()),
      other = new JSDOM("<!doctype html>", { runScripts: "dangerously", url: "https://other.example/", beforeParse() {} }).window;
    app.window.dispatchEvent(
      new app.window.MessageEvent("message", { data: toolResult({ storyId: "story", uploadUrl }), source: other as unknown as Window })
    );
    expect((app.element("photos") as HTMLInputElement).disabled).toBe(true);
  });

  it("BUI-2204 R2: each file shows a progress bar that follows its upload", async () => {
    const app = picker(vi.fn(async () => signedPut("one.jpg")));
    app.deliver(toolResult({ storyId: "story", uploadUrl }));
    app.pick([new app.window.File(["abcd"], "one.jpg", { type: "image/jpeg" })]);
    await vi.waitFor(() => expect(FakeUpload.sent).toHaveLength(1));
    const bar = app.window.document.querySelector("#files li progress") as HTMLProgressElement;
    expect(bar.max).toBe(100);
    expect(bar.value).toBe(0);
    FakeUpload.sent[0]!.progress(3, 4);
    expect(bar.value).toBe(75);
    FakeUpload.sent[0]!.finish(200);
    await vi.waitFor(() => expect(bar.value).toBe(100));
  });
});
