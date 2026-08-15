import { chromium, type APIResponse, type BrowserContext, type Page } from "@playwright/test";
import { assertPreviewUrl, readPreviewRunMode } from "@/lib/web/preview-policy";

type Story = { id: string; status: string; publicSlug?: string; title: string; version: number };
type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };
type StoryEnvelope = { story: Story; csrfToken?: string };

const baseUrl = assertPreviewUrl(process.env.WANDERPAGE_PREVIEW_URL ?? "", allowlistedHosts());
const runMode = readPreviewRunMode(process.env);
const timeoutMs = positiveInteger(process.env.WANDERPAGE_HOSTED_TIMEOUT_MS, 600_000);

function allowlistedHosts() {
  return (process.env.WANDERPAGE_PREVIEW_ALLOWLIST ?? "")
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("WANDERPAGE_HOSTED_TIMEOUT_MS must be a positive integer.");
  return parsed;
}

function origin() {
  return baseUrl.origin;
}

function mark(check: string, details?: string) {
  console.log(JSON.stringify({ event: "check", check, details }));
}

async function readJson<T>(response: APIResponse, method: string) {
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok() || !body.data) {
    throw new Error(`${method} ${response.url()} returned ${response.status()}: ${body.error?.code ?? "UNKNOWN"}`);
  }
  return body.data;
}

async function apiRequest<T>(context: BrowserContext, path: string, method = "GET", csrfToken?: string, body?: unknown) {
  const response = await context.request.fetch(new URL(path, baseUrl).toString(), {
    method,
    data: body,
    headers: { Origin: origin(), ...(csrfToken ? { "x-wanderpage-csrf": csrfToken } : {}) },
  });
  return readJson<T>(response, method);
}

async function expectStatus(context: BrowserContext, path: string, status: number) {
  const response = await context.request.get(new URL(path, baseUrl).toString());
  if (response.status() !== status) throw new Error(`GET ${path} returned ${response.status()}, expected ${status}.`);
  return response;
}

async function createAndUpload(page: Page) {
  await page.goto(new URL("/create", baseUrl).toString(), { waitUntil: "networkidle" });
  await page.getByLabel("Story title").fill("Hosted preview acceptance");
  await page.getByLabel(/Photos \(JPEG/).setInputFiles(
    Array.from({ length: 6 }, (_, index) => ({
      name: `acceptance-${index + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    }))
  );
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Upload privately" }).click();
  await page.getByRole("status").filter({ hasText: "Photos uploaded privately" }).waitFor({ state: "visible", timeout: timeoutMs });
  const href = await page.getByRole("link", { name: /Open private review/ }).getAttribute("href");
  const storyId = href?.match(/^\/stories\/([0-9a-f-]+)$/i)?.[1];
  if (!storyId) throw new Error("The hosted creator did not return a private story link.");
  return storyId;
}

async function waitForStory(context: BrowserContext, storyId: string) {
  const deadline = Date.now() + timeoutMs;
  let latest: Story | undefined;
  while (Date.now() < deadline) {
    latest = (await apiRequest<StoryEnvelope>(context, `/api/stories/${storyId}`, "GET")).story;
    if (["draft", "published", "failed"].includes(latest.status)) return latest;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error(`Story ${storyId} did not finish processing before timeout (last status ${latest?.status ?? "unknown"}).`);
}

async function deleteStory(context: BrowserContext, storyId: string, csrfToken: string) {
  const response = await context.request.delete(new URL(`/api/stories/${storyId}`, baseUrl).toString(), {
    headers: { Origin: origin(), "x-wanderpage-csrf": csrfToken },
  });
  if (![204, 404].includes(response.status())) throw new Error(`DELETE story returned ${response.status()}.`);
}

async function run() {
  const browser = await chromium.launch();
  const owner = await browser.newContext();
  const otherOwner = await browser.newContext();
  let storyId: string | undefined;
  let csrfToken: string | undefined;
  try {
    const demo = await owner.request.get(new URL("/demo", baseUrl).toString());
    if (!demo.ok() || !(await demo.text()).includes("Wanderpage")) throw new Error("/demo did not render the deployed app.");
    mark("demo-route");

    const create = await owner.request.get(new URL("/create", baseUrl).toString());
    if (!create.ok() || !(await create.text()).includes("Private browser creation"))
      throw new Error("/create did not render the hosted creator.");
    mark("create-route");

    const unauthenticated = await otherOwner.request.get(new URL("/api/stories", baseUrl).toString());
    if (unauthenticated.status() !== 401 || ((await unauthenticated.json()) as ApiEnvelope<unknown>).error?.code !== "AUTH_REQUIRED") {
      throw new Error("Unauthenticated story listing did not fail closed with AUTH_REQUIRED.");
    }
    mark("unauthenticated-api");

    const page = await owner.newPage();
    storyId = await createAndUpload(page);
    const listed = await apiRequest<{ stories: Story[]; csrfToken: string }>(owner, "/api/stories");
    const story = listed.stories.find(item => item.id === storyId);
    if (!story) throw new Error("Owner listing did not include the uploaded story.");
    csrfToken = listed.csrfToken;
    mark("private-upload", story.status);

    const forbidden = await otherOwner.request.get(new URL(`/api/stories/${storyId}`, baseUrl).toString());
    if (![401, 404].includes(forbidden.status())) throw new Error(`Second browser accessed the private story (${forbidden.status()}).`);
    mark("owner-isolation");

    if (runMode === "smoke") {
      await deleteStory(owner, storyId, csrfToken);
      mark("delete-unpublished");
      return;
    }

    const queued = await apiRequest<StoryEnvelope>(owner, `/api/stories/${storyId}/generate`, "POST", csrfToken);
    const finished = await waitForStory(owner, storyId);
    if (finished.status === "failed") throw new Error("Hosted generation reached failed status.");
    mark("generation", finished.status);
    const published = await apiRequest<StoryEnvelope>(owner, `/api/stories/${storyId}/publish`, "POST", csrfToken, { action: "publish" });
    if (!published.story.publicSlug) throw new Error("Publish did not return a public slug.");
    const publicPage = await owner.request.get(new URL(`/s/${published.story.publicSlug}`, baseUrl).toString());
    const publicHtml = await publicPage.text();
    if (!publicPage.ok() || publicHtml.includes("file://") || /latitude|longitude|gps/i.test(publicHtml))
      throw new Error("Published output failed metadata privacy checks.");
    mark("publish-privacy");
    await apiRequest<StoryEnvelope>(owner, `/api/stories/${storyId}/publish`, "POST", csrfToken, { action: "unpublish" });
    await expectStatus(owner, `/s/${published.story.publicSlug}`, 404);
    mark("unpublish");
    await deleteStory(owner, storyId, csrfToken);
    mark("delete-published");
    void queued;
  } finally {
    if (storyId && csrfToken) await deleteStory(owner, storyId, csrfToken).catch(() => undefined);
    await owner.close();
    await otherOwner.close();
    await browser.close();
  }
}

run()
  .then(() => console.log(JSON.stringify({ event: "result", result: "PASS", mode: runMode })))
  .catch(error => {
    console.error(
      JSON.stringify({ event: "result", result: "FAIL", mode: runMode, error: error instanceof Error ? error.message : String(error) })
    );
    process.exitCode = 1;
  });
