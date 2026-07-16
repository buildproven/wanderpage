import { expect, test } from "@playwright/test";

test("explains Wanderpage and opens a complete static story", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Your trip, beautifully edited/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /A camera roll is evidence/ })).toBeVisible();
  await page.getByRole("link", { name: /Explore a finished story/ }).click();
  await expect(page).toHaveURL(/\/demo\/?$/);
  await expect(page.getByRole("heading", { name: "A Line Along the Pacific" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Frames from/ })).toBeVisible();
  const first = page.locator(".gallery-button").first();
  await first.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});
