import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceStaticOutput } from "@/lib/static-output";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

const built: Record<string, string> = {
  "index.html": "<h1>My story</h1>",
  "trips/oregon.html": "<h1>Oregon</h1>",
  "trips/oregon.txt": "rsc",
  "_next/static/app.js": "js",
  "trip/generated/oregon-large.webp": "mine",
  "_next/static/chunks/app/studio/page.js": "studio js",
  "_next/static/chunks/app/demo/page.js": "demo js",
  "studio.html": "<h1>Studio</h1>",
  "studio.txt": "rsc",
  "studio/index.html": "<h1>Studio</h1>",
  "demo.html": "<h1>Demo</h1>",
  "demo.txt": "rsc",
  "demo/index.html": "<h1>Demo</h1>",
  "trip/demo/coast-hero-large.webp": "demo",
};

async function files(directory: string, base = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(entry =>
      entry.isDirectory() ? files(join(directory, entry.name), base) : [join(directory, entry.name).slice(base.length + 1)]
    )
  );
  return nested.flat().sort();
}

async function writeTree(directory: string) {
  for (const [path, content] of Object.entries(built)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

// @verifies DES-PUB-EXPORT, ARCH-PUBLISH, REQ-PUB-08, REQ-PUB-10, SN-05, SN-08
describe("shareable site folder", () => {
  const workspaces: string[] = [];
  afterEach(async () => Promise.all(workspaces.splice(0).map(removeTempWorkspace)));

  async function publish() {
    const root = await createTempWorkspace("shareable-site");
    workspaces.push(root);
    const output = join(root, "built");
    await writeTree(output);
    await replaceStaticOutput(root, output);
    return root;
  }

  it("holds the story and no Studio page, demo page or demo-trip image", async () => {
    const root = await publish(),
      site = await files(join(root, "out/site"));
    expect(site).toEqual([
      "_next/static/app.js",
      "index.html",
      "trip/generated/oregon-large.webp",
      "trips/oregon.html",
      "trips/oregon.txt",
    ]);
  });

  it("keeps Studio and the demo loadable from out/", async () => {
    const root = await publish(),
      out = (await files(join(root, "out"))).filter(path => !path.startsWith("site/"));
    expect(out).toEqual(Object.keys(built).sort());
    await expect(readFile(join(root, "out/studio.html"), "utf8")).resolves.toBe("<h1>Studio</h1>");
  });

  it("rebuilds the folder on each publish without nesting the previous one", async () => {
    const root = await publish();
    await rm(join(root, "built/trips/oregon.html"));
    await replaceStaticOutput(root, join(root, "built"));
    const site = await files(join(root, "out/site"));
    expect(site).not.toContain("trips/oregon.html");
    expect(site.some(path => path.startsWith("site/"))).toBe(false);
  });

  it("does not mistake a story named like a tool page for one", async () => {
    const root = await createTempWorkspace("shareable-site-names");
    workspaces.push(root);
    const output = join(root, "built");
    await mkdir(join(output, "trips"), { recursive: true });
    await writeFile(join(output, "trips/studio.html"), "mine");
    await writeFile(join(output, "trips/demo.html"), "mine");
    await replaceStaticOutput(root, output);
    expect(await files(join(root, "out/site"))).toEqual(["trips/demo.html", "trips/studio.html"]);
  });
});
