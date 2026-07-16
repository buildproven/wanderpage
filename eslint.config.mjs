import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".claude-kit/**", ".next/**", "out/**", ".trip-cache/**", ".trip-output/**", "public/trip/**"]),
]);
