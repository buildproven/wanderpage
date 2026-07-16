import { expect, test } from "@playwright/test";

test("explains Wanderpage and opens a complete static story", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Your trip, beautifully edited/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /A camera roll is evidence/ })).toBeVisible();
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
