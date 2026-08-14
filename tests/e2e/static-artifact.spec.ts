import { expect, test } from "@playwright/test";

test("the exact static rollback artifact serves a complete story", async ({ page }) => {
  const failedResponses: string[] = [],
    consoleErrors: string[] = [];
  page.on("response", response => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("http://127.0.0.1:4174/demo/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "A Line Along the Pacific" })).toBeVisible();
  const images = page.locator("img");
  await expect(images.first()).toBeVisible();
  for (const image of await images.all()) await image.scrollIntoViewIfNeeded();
  await expect.poll(() => images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(failedResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
