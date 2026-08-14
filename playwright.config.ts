import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:4173", trace: "on-first-retry" },
  webServer: [
    { command: "pnpm preview --port 4173", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI, timeout: 120000 },
    {
      command: "pnpm exec serve out --listen 4174 --no-clipboard",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
});
