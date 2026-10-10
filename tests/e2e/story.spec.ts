import { expect, test } from "@playwright/test";

// @verifies DES-SITE-LANDING, DES-SITE-STORY, ARCH-SITE, REQ-UI-05, REQ-UI-06, SN-06, SN-08
test("explains Wanderpage and opens a complete static story", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Your trip, beautifully edited/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /A camera roll is evidence/ })).toBeVisible();
  await expect(page.locator(".product-hero-folio")).toContainText("Four-day edit");
  await expect(page.locator(".product-hero-folio")).not.toContainText(/\d+\.\d+°/);
  // Hosted creation is not part of v1, so the exported site must not point at a page it does not contain.
  await expect(page.locator('a[href="/create"]')).toHaveCount(0);
  await page.getByRole("link", { name: /Explore a finished story/ }).click();
  await expect(page).toHaveURL(/\/demo\/?$/);
  await expect(page.getByRole("heading", { name: "A Line Along the Pacific" })).toBeVisible();
  await page.getByRole("link", { name: /Read the story/ }).click();
  const opening = page.locator(".intro blockquote");
  await expect(opening).toBeVisible();
  const openingFontSize = await opening.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(openingFontSize).toBeLessThanOrEqual(38);
  await expect(page.getByRole("heading", { name: /Frames from/ })).toBeVisible();
  const galleryImages = page.locator(".gallery-button img");
  await expect(galleryImages.first()).toBeVisible();
  await galleryImages.last().scrollIntoViewIfNeeded();
  await expect
    .poll(() => galleryImages.evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
  const aspectRatioErrors = await galleryImages.evaluateAll(images =>
    images.map(image => {
      const photo = image as HTMLImageElement;
      return Math.abs(photo.clientWidth / photo.clientHeight - photo.naturalWidth / photo.naturalHeight);
    })
  );
  expect(Math.max(...aspectRatioErrors)).toBeLessThan(0.02);
  const first = page.locator(".gallery-button").first();
  await first.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

// @verifies DES-SITE-STORY, REQ-UI-06
test("a direct demo visit explains how Wanderpage made the story", async ({ page }) => {
  await page.goto("/demo");

  await expect(page.getByRole("heading", { name: /Made by Wanderpage/ })).toBeVisible();
  await expect(page.getByText(/generated from a folder of travel photos/i)).toBeVisible();
  await expect(page.getByText(/exact GPS and camera metadata removed/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /See how Wanderpage works/ })).toHaveAttribute("href", "/");

  const gallerySources = await page
    .locator(".gallery-button img")
    .evaluateAll(images => images.map(image => new URL((image as HTMLImageElement).src).pathname));
  expect(new Set(gallerySources).size).toBe(8);
});

// @verifies DES-SITE-STORY, ARCH-SITE, REQ-UI-05, SN-08
test("the story is readable without a mouse or horizontal scrolling and describes every photo", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const missingAlt = await page
    .locator("img")
    .evaluateAll(images => images.filter(image => !(image.getAttribute("alt") ?? "").trim()).length);
  expect(missingAlt).toBe(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const first = page.locator(".gallery-button").first();
  await first.scrollIntoViewIfNeeded();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// @verifies DES-SITE-STORY, ARCH-SITE, REQ-UI-05, SN-08
test("the story prints without navigation and with every chapter visible", async ({ page }) => {
  await page.goto("/demo");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".hero-nav")).toBeHidden();
  const chapters = page.locator(".chapter-heading");
  expect(await chapters.count()).toBeGreaterThan(1);
  const opacities = await chapters.evaluateAll(items => items.map(item => getComputedStyle(item).opacity));
  expect(opacities.every(opacity => opacity === "1")).toBe(true);
});
