import { expect, test } from "@playwright/test";

// @verifies DES-SITE-STORY, ARCH-SITE, REQ-UI-05, SN-08
test("the photo viewer plays a slideshow and answers a swipe", async ({ page }) => {
  await page.clock.install();
  await page.goto("/demo");
  await page.locator(".gallery-button").first().scrollIntoViewIfNeeded();
  await page.locator(".gallery-button").first().click();
  const counter = page.locator(".lightbox-top > span");
  await expect(counter).toHaveText(/^1 \//);

  await page.getByRole("button", { name: "Play slideshow" }).click();
  await page.clock.fastForward(4100);
  await expect(counter).toHaveText(/^2 \//);
  await page.getByRole("button", { name: "Pause slideshow" }).click();
  await page.clock.fastForward(9000);
  await expect(counter).toHaveText(/^2 \//);

  const media = page.locator(".lightbox-media");
  await media.dispatchEvent("touchstart", {
    touches: [{ identifier: 1, clientX: 300, clientY: 300 }],
    changedTouches: [{ identifier: 1, clientX: 300, clientY: 300 }],
  });
  await media.dispatchEvent("touchend", { changedTouches: [{ identifier: 1, clientX: 100, clientY: 300 }] });
  await expect(counter).toHaveText(/^3 \//);
  await media.dispatchEvent("touchstart", {
    touches: [{ identifier: 1, clientX: 100, clientY: 300 }],
    changedTouches: [{ identifier: 1, clientX: 100, clientY: 300 }],
  });
  await media.dispatchEvent("touchend", { changedTouches: [{ identifier: 1, clientX: 110, clientY: 300 }] });
  await expect(counter).toHaveText(/^3 \//);
});
