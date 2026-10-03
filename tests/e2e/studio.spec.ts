import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { TripManifest } from "../../lib/schemas/trip";

const manifest = {
  ...(JSON.parse(readFileSync(new URL("../../data/trip.demo.json", import.meta.url), "utf8")) as TripManifest),
  published: false,
};

// @verifies DES-STUDIO-UI, ARCH-STUDIO, REQ-UI-02, REQ-UI-03, SN-01, SN-05
test("creates a story through the local Studio interface", async ({ page, context }) => {
  let jobReads = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/status")
      return route.fulfill({ json: { ready: true, openaiConfigured: false, platform: "darwin", projectPath: "/Users/test/wanderpage" } });
    if (path === "/api/trips") return route.fulfill({ json: { trips: [] } });
    if (path === "/api/folders/pick") return route.fulfill({ json: { path: "/Users/test/Pictures/Oregon" } });
    if (path === "/api/jobs" && request.method() === "POST") return route.fulfill({ status: 202, json: { id: "fixture-job" } });
    if (path === "/api/jobs/fixture-job") {
      jobReads++;
      if (jobReads < 2)
        return route.fulfill({
          json: {
            id: "fixture-job",
            status: "running",
            createdAt: "2026-07-15T12:00:00Z",
            updatedAt: "2026-07-15T12:00:01Z",
            request: { input: "/Users/test/Pictures/Oregon", people: "include", maxPhotos: 36, privacy: "approximate" },
            progress: { stage: "analyze", progress: 56, message: "Analyzing contact sheet 1 of 1", at: "2026-07-15T12:00:01Z" },
          },
        });
      return route.fulfill({
        json: {
          id: "fixture-job",
          status: "complete",
          createdAt: "2026-07-15T12:00:00Z",
          updatedAt: "2026-07-15T12:00:03Z",
          request: { input: "/Users/test/Pictures/Oregon", people: "include", maxPhotos: 36, privacy: "approximate" },
          progress: { stage: "complete", progress: 100, message: "Your trip page is ready", at: "2026-07-15T12:00:03Z" },
          result: {
            path: "/trips/a-line-along-the-pacific",
            manifest,
            summary: { inputPhotos: 8, selectedPhotos: 8, duplicatesRemoved: 0, basicEdit: true },
            selection: { selected: manifest.photos.map(photo => photo.id), rejected: [], reasons: {} },
          },
        },
      });
    }
    if (path === "/api/trips/a-line-along-the-pacific" && request.method() === "PATCH") return route.fulfill({ json: { manifest } });
    if (path === "/api/trips/a-line-along-the-pacific/publish" && request.method() === "POST")
      return route.fulfill({ json: { manifest: { ...manifest, published: true } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/studio");
  await expect(page.getByText("Local engine ready")).toBeVisible();
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/folders/pick" && response.status() === 200),
    page.getByRole("button", { name: "Choose folder" }).click(),
  ]);
  await expect(page.getByLabel("Photo folder path")).toHaveValue("/Users/test/Pictures/Oregon");
  await page.getByLabel(/Story title/).fill("Oregon, held in light");
  await page.getByRole("button", { name: /Build my Wanderpage/ }).click();
  await expect(page.getByRole("heading", { name: /Analyzing contact sheet/ })).toBeVisible();
  await expect(page.getByText("Draft ready for review")).toBeVisible();
  await expect(page.getByRole("heading", { name: "A Line Along the Pacific" })).toBeVisible();
  await expect(page.getByText("Privacy check")).toBeVisible();
  await expect(page.getByText("This is a basic edit, so the title and captions are generic")).toBeVisible();
  await page.getByRole("button", { name: /Publish this story/ }).click();
  await expect(page.getByText(/Your shareable site is the folder/)).toContainText("/Users/test/wanderpage/out");
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("link", { name: /Open published story/ }).click();
  const story = await popupPromise;
  await story.waitForLoadState();
  expect(story.url()).toMatch(/\/trips\/a-line-along-the-pacific/);
});

// @verifies DES-STUDIO-UI, REQ-UI-02, SN-07
test("keeps a failed edit visible in the Studio docket", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/status") return route.fulfill({ json: { ready: true, openaiConfigured: true, platform: "darwin" } });
    if (path === "/api/trips") return route.fulfill({ json: { trips: [] } });
    if (path === "/api/jobs" && request.method() === "POST") return route.fulfill({ status: 202, json: { id: "failed-job" } });
    if (path === "/api/jobs/failed-job")
      return route.fulfill({
        json: {
          id: "failed-job",
          status: "failed",
          createdAt: "2026-07-15T12:00:00Z",
          updatedAt: "2026-07-15T12:00:01Z",
          request: { input: "/Users/test/Pictures/Oregon", people: "include", maxPhotos: 36, privacy: "approximate" },
          progress: { stage: "ingest", progress: 4, message: "Reading photo folder", at: "2026-07-15T12:00:01Z" },
          error: "Photo folder is no longer readable.",
        },
      });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/studio");
  await page.getByLabel("Photo folder path").fill("/Users/test/Pictures/Oregon");
  await page.getByRole("button", { name: /Build my Wanderpage/ }).click();
  await expect(page.getByText("EDIT FAILED")).toBeVisible();
  await expect(page.locator(".studio-error")).toHaveText("Photo folder is no longer readable.");
});

// @verifies DES-STUDIO-UI, ARCH-STUDIO, REQ-AI-05, REQ-LOC-03, SN-06, SN-07
test("says so plainly when no API key is set and offers every location privacy level", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status") return route.fulfill({ json: { ready: true, openaiConfigured: false, platform: "darwin" } });
    if (path === "/api/trips") return route.fulfill({ json: { trips: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/studio");
  await expect(page.getByRole("status")).toContainText("basic edit");
  await expect(page.getByRole("status")).toContainText("no people detection");
  await expect(page.getByRole("radio", { name: /Exclude/ })).toBeDisabled();
  const privacy = page.getByRole("group", { name: "Location privacy" });
  for (const label of ["Approximate", "Region only", "No locations", "Closer"])
    await expect(privacy.getByRole("radio", { name: new RegExp(label) })).toBeVisible();
});

// @verifies DES-STUDIO-UI, ARCH-STUDIO, REQ-UI-02, SN-06
test("the first screen's decorative route marker never overlaps the tagline", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status")
      return route.fulfill({ json: { ready: true, openaiConfigured: true, platform: "darwin", projectPath: "/p" } });
    if (path === "/api/trips") return route.fulfill({ json: { trips: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/studio");
  const marker = page.locator(".studio-route-mark"),
    tagline = page.locator(".studio-atmosphere-copy p");
  test.skip(!(await marker.isVisible()), "the decorative panel is hidden at this screen size");
  const [markerBox, taglineBox] = [await marker.boundingBox(), await tagline.boundingBox()];
  expect(markerBox!.y + markerBox!.height).toBeLessThanOrEqual(taglineBox!.y);
});
