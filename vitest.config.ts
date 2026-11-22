import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  test: {
    environment: "node",
    // tests/helpers/workspace.ts makes `.wanderpage-test-*` workspaces in the repo root; a killed run can leave one holding copied test files.
    exclude: ["tests/e2e/**", "node_modules/**", ".wanderpage-test-*/**"],
    coverage: { enabled: false },
  },
  resolve: { alias: { "@": resolve(__dirname, ".") } },
});
