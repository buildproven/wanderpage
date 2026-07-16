import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  test: { environment: "node", exclude: [".claude-kit/**", "tests/e2e/**", "node_modules/**"], coverage: { enabled: false } },
  resolve: { alias: { "@": resolve(__dirname, ".") } },
});
