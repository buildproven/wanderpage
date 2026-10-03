// @design DES-QA-TRACE
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { check, parseDocument, parseTags, render, type Item, type Level, type Model } from "./trace-model";

const documents: Array<[string, Level[]]> = [
  ["docs/REQUIREMENTS.md", ["SN", "REQ"]],
  ["docs/ARCHITECTURE.md", ["ARCH"]],
  ["docs/DESIGN.md", ["DES"]],
];
const matrixPath = "docs/TRACEABILITY.md";
const codePattern = /^(?:app|assets|components|lib|scripts|bin|workflows)\/.*\.(?:ts|tsx|js|mjs)$|^proxy\.ts$/;
const testPattern = /^(?:tests|components)\/.*(?:\.test\.tsx?|\.spec\.ts)$/;

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .sort();
const codeFiles = tracked.filter(file => codePattern.test(file) && !testPattern.test(file) && !file.includes("/.well-known/"));
const testFiles = tracked.filter(file => testPattern.test(file));

const items: Item[] = [],
  errors: string[] = [];
for (const [path, levels] of documents) {
  const parsed = parseDocument(readFileSync(path, "utf8"), path, levels);
  items.push(...parsed.items);
  errors.push(...parsed.errors);
}

const model: Model = {
  items,
  codeFiles,
  testFiles,
  designTags: codeFiles.flatMap(file => parseTags(readFileSync(file, "utf8"), file, "design")),
  verifyTags: testFiles.flatMap(file => parseTags(readFileSync(file, "utf8"), file, "verifies")),
};
errors.push(...check(model));

const matrix = render(model);
if (process.argv.includes("--write")) {
  if (errors.length) {
    console.error(`Traceability errors (${errors.length}):\n${errors.map(error => `  - ${error}`).join("\n")}`);
    process.exit(1);
  }
  writeFileSync(matrixPath, matrix);
  console.log(`Wrote ${matrixPath}: ${items.length} items, ${testFiles.length} test files, ${codeFiles.length} source files.`);
} else {
  const current = (() => {
    try {
      return readFileSync(matrixPath, "utf8");
    } catch {
      return "";
    }
  })();
  if (!errors.length && current !== matrix) errors.push(`${matrixPath} is stale; run "pnpm trace:write"`);
  if (errors.length) {
    console.error(`Traceability errors (${errors.length}):\n${errors.map(error => `  - ${error}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Traceability OK: ${items.length} items, ${testFiles.length} test files, ${codeFiles.length} source files.`);
}
