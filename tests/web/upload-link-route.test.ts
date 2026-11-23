import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upload } from "@vercel/blob/client";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import { MemoryUploadLinkStore, sealUploadLink, uploadLinkKey, UploadLinks } from "@/lib/web/upload-link";
import { createUploadLinkHandlers } from "@/app/api/mcp/_hosted/upload-page";
import { proxy } from "@/proxy";
import { uploadPhotos } from "@/lib/web/photo-upload";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));

const origin = "https://wanderpage.example",
  pepper = ["route", "test", "pepper", "value", "long", "enough", "here"].join("-"),
  storyInput = {
    title: "Kyoto <in> autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

async function fixture() {
  const repository = new MemoryStoryRepository(),
    stories = new StoryService(
      repository,
      { start: async () => ({ workflowRunId: "workflow" }) },
      undefined,
      value => `hash:${value}`,
      () => ({ enabled: true, dailyLimit: 25 })
    ),
    created = await stories.createSessionWithStory(storyInput, "client"),
    store = new MemoryUploadLinkStore(),
    clock = { now: new Date() },
    links = new UploadLinks({ store, key: uploadLinkKey(pepper), now: () => clock.now }),
    handlers = createUploadLinkHandlers(() => ({ stories, links })),
    issued = await links.issue(created.story.id, created.rawSecret);
  return { stories, store, clock, links, handlers, created, token: issued.token };
}

const get = (token: string) => new Request(`${origin}/upload/${token}`);
const post = (token: string, headers: Record<string, string> = {}) =>
  new Request(`${origin}/upload/${token}`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "",
  });

function setCookies(response: Response) {
  return response.headers.getSetCookie();
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01, REQ-WEB-10
describe("upload link page (BUI-2095)", () => {
  it("BUI-2095 R4: GET shows the escaped story title and a Continue form and leaves the link unused", async () => {
    const { handlers, store, token } = await fixture(),
      response = await handlers.GET(get(token), token),
      html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(html).toContain("Kyoto &lt;in&gt; autumn");
    expect(html).not.toContain("<in>");
    expect(html).toContain(`<form method="post" action="/upload/${token}">`);
    expect(html).toContain(">Continue</button>");
    expect(setCookies(response)).toEqual([]);
    expect(store.rows()[0]?.usedAt).toBeUndefined();
    // A second preview fetch still finds the link unused.
    expect((await handlers.GET(get(token), token)).status).toBe(200);
  });

  it("BUI-2095 R5: POST uses the link, sets a 1-hour httpOnly owner cookie and the marker, and answers 303 to the story", async () => {
    const { handlers, store, token, created } = await fixture(),
      response = await handlers.POST(post(token), token);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/stories/${created.story.id}`);
    const cookies = setCookies(response),
      owner = cookies.find(value => value.startsWith("wanderpage_owner=")),
      marker = cookies.find(value => value.startsWith("wanderpage_owner_ttl="));
    expect(owner).toContain(`wanderpage_owner=${created.rawSecret}`);
    expect(owner).toMatch(/Max-Age=3600(;|$)/);
    expect(owner).toMatch(/HttpOnly/i);
    expect(owner).toMatch(/SameSite=lax/i);
    expect(owner).toMatch(/Path=\//);
    expect(marker).toContain("wanderpage_owner_ttl=link");
    expect(marker).toMatch(/Max-Age=3600(;|$)/);
    expect(store.rows()[0]?.usedAt).toBeInstanceOf(Date);
  });

  it("BUI-2095 R5: the owner cookie is secure in production", async () => {
    const { handlers, token } = await fixture(),
      previous = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: "production" });
    try {
      const owner = setCookies(await handlers.POST(post(token), token)).find(value => value.startsWith("wanderpage_owner="));
      expect(owner).toMatch(/Secure/i);
    } finally {
      Object.assign(process.env, { NODE_ENV: previous });
    }
  });

  it("BUI-2095 R5: a form POST whose content type carries a charset is accepted", async () => {
    const { handlers, token } = await fixture(),
      response = await handlers.POST(post(token, { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }), token);
    expect(response.status).toBe(303);
  });

  it("BUI-2095 R8: a second POST answers 410 with a short page and no cookie, and GET then says the link is no longer valid", async () => {
    const { handlers, token } = await fixture();
    expect((await handlers.POST(post(token), token)).status).toBe(303);
    const again = await handlers.POST(post(token), token);
    expect(again.status).toBe(410);
    expect(setCookies(again)).toEqual([]);
    expect(await again.text()).toContain("This upload link is no longer valid.");
    const page = await handlers.GET(get(token), token);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This upload link is no longer valid.");
  });

  it("BUI-2095 R8: an expired token answers 410 with no cookie on POST and GET", async () => {
    const { handlers, clock, token } = await fixture();
    clock.now = new Date(clock.now.getTime() + 15 * 60 * 1000 + 1);
    const response = await handlers.POST(post(token), token);
    expect(response.status).toBe(410);
    expect(setCookies(response)).toEqual([]);
    const page = await handlers.GET(get(token), token);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This upload link is no longer valid.");
  });

  it("BUI-2095 R8: a forged or tampered token answers 410 with no cookie and leaves the real link unused", async () => {
    const { handlers, store, token, created } = await fixture(),
      forged = sealUploadLink(
        {
          linkId: store.rows()[0]?.id ?? "",
          storyId: created.story.id,
          expiresAt: new Date(Date.now() + 60_000),
          ownerSecret: created.rawSecret,
        },
        uploadLinkKey(`${pepper}-attacker`)
      ),
      tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    for (const value of [forged, tampered, "garbage"]) {
      const response = await handlers.POST(post(value), value);
      expect(response.status).toBe(410);
      expect(setCookies(response)).toEqual([]);
      expect((await handlers.GET(get(value), value)).status).toBe(410);
    }
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2095 R5: a cross-origin or non-form POST is refused with no cookie and leaves the link unused", async () => {
    const { handlers, store, token } = await fixture(),
      crossSite = await handlers.POST(post(token, { origin: "https://attacker.example" }), token),
      noOrigin = await handlers.POST(
        new Request(`${origin}/upload/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } }),
        token
      ),
      json = await handlers.POST(post(token, { "content-type": "application/json" }), token);
    for (const response of [crossSite, noOrigin, json]) {
      expect(response.status).toBe(403);
      expect(setCookies(response)).toEqual([]);
    }
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2095 R8: a link whose story has been deleted answers 410 and stays unused", async () => {
    const { handlers, store, token, created, stories } = await fixture();
    await stories.prepareDelete(created.rawSecret, created.story.id);
    const response = await handlers.POST(post(token), token);
    expect(response.status).toBe(410);
    expect(setCookies(response)).toEqual([]);
    expect(store.rows()[0]?.usedAt).toBeUndefined();
  });

  it("BUI-2095 R6: with the link marker present, the proxy does not extend the owner cookie past 1 hour", () => {
    const marked = proxy(
        new NextRequest(`${origin}/stories/story-id`, { headers: { cookie: "wanderpage_owner=opaque-value; wanderpage_owner_ttl=link" } })
      ),
      renewed = marked.cookies.get("wanderpage_owner");
    expect(renewed === undefined || (renewed.maxAge ?? 0) <= 60 * 60).toBe(true);
    expect(marked.headers.getSetCookie().join("\n")).not.toContain("Max-Age=2592000");
    const unmarked = proxy(new NextRequest(`${origin}/stories/story-id`, { headers: { cookie: "wanderpage_owner=opaque-value" } }));
    expect(unmarked.cookies.get("wanderpage_owner")?.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("BUI-2095 R5, R6: the proxy does not renew the old owner cookie on the upload link page", () => {
    const response = proxy(
      new NextRequest(`${origin}/upload/abc`, { method: "POST", headers: { cookie: "wanderpage_owner=older-value" } })
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("BUI-2095 R7: the static export removes app/upload with the other server-only folders", async () => {
    const script = await readFile("scripts/static-export.ts", "utf8"),
      list = /for \(const serverOnly of \[([\s\S]*?)\]\)/.exec(script)?.[1] ?? "";
    expect(list).toContain('"app/upload"');
    expect(list).toContain('"app/api"');
  });
});

// @verifies DES-WEB-UPLOAD, ARCH-WEB-UPLOAD, REQ-WEB-03
describe("shared photo upload helper (BUI-2095)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(upload).mockReset();
  });

  it("BUI-2095 R9: reserves each file, then uploads it to private Blob through /api/uploads, and reports progress", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { originalName } = JSON.parse(String(init.body)) as { originalName: string };
      return Response.json({ data: { upload: { blobPath: `sources/story/${originalName}` }, uploadPayload: `payload-${originalName}` } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const files = [new File(["a"], "one.jpg", { type: "image/jpeg" }), new File(["bb"], "two.webp", { type: "image/webp" })],
      uploading: number[] = [],
      stored: number[] = [];
    await expect(
      uploadPhotos({
        storyId: "story",
        files,
        csrfToken: "header-value",
        onUploading: position => uploading.push(position),
        onStored: count => stored.push(count),
      })
    ).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/upload-reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wanderpage-csrf": "header-value" },
      body: JSON.stringify({ storyId: "story", originalName: "one.jpg", contentType: "image/jpeg", byteSize: 1 }),
    });
    expect(upload).toHaveBeenCalledWith("sources/story/two.webp", files[1], {
      access: "private",
      handleUploadUrl: "/api/uploads",
      clientPayload: "payload-two.webp",
      headers: { "x-wanderpage-csrf": "header-value" },
      contentType: "image/webp",
    });
    expect(uploading).toEqual([1, 2]);
    expect(stored).toEqual([1, 2]);
  });

  it("BUI-2095 R9: a refused reservation rejects with the server's message and uploads nothing more", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "A Wanderpage story supports at most 60 photos." } }, { status: 400 }))
    );
    await expect(
      uploadPhotos({ storyId: "story", files: [new File(["a"], "one.jpg", { type: "image/jpeg" })], csrfToken: "header-value" })
    ).rejects.toThrow("A Wanderpage story supports at most 60 photos.");
    expect(upload).not.toHaveBeenCalled();
  });
});
