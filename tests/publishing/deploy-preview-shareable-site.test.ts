import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceStaticOutput } from "@/lib/static-output";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

// The deploy entry point resolves its default folder against the working directory, so the scan is replaced by a pass-through
// and the test resolves the folder the deployer receives against a fixture export instead.
const scannedPaths: string[] = [];
vi.mock("@/lib/publishing/privacy", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/publishing/privacy")>();
  return {
    ...actual,
    deployAfterPrivacyScan: async ({ outputPath, deploy }: { outputPath: string; deploy: () => Promise<void> }) => {
      scannedPaths.push(outputPath);
      await deploy();
      return { deployed: true, findings: [] };
    },
  };
});

const { deploy } = await import("@/scripts/deploy");

const built: Record<string, string> = {
  "index.html": "<h1>My story</h1>",
  "trips/oregon.html": "<h1>Oregon</h1>",
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

const workspaces: string[] = [];
afterEach(async () => {
  scannedPaths.splice(0);
  await Promise.all(workspaces.splice(0).map(removeTempWorkspace));
});

/** A project root holding a real `out/` export with Studio, the demo and the shareable `out/site/`. */
async function exportedProject() {
  const root = await createTempWorkspace("deploy-preview-site");
  workspaces.push(root);
  const output = join(root, "built");
  for (const [path, content] of Object.entries(built)) {
    await mkdir(join(output, path, ".."), { recursive: true });
    await writeFile(join(output, path), content);
  }
  await replaceStaticOutput(root, output);
  return root;
}

function expectStoryOnly(shipped: string[]) {
  expect(shipped).toContain("index.html");
  expect(shipped).toContain("trips/oregon.html");
  const toolPages = shipped.filter(path => /(^|\/)(studio|demo)(\/|\.|$)/.test(path));
  expect(toolPages).toEqual([]);
}

// @verifies DES-CLI-TRIP, ARCH-PUBLISH, REQ-PUB-08, SN-05, SN-08
describe("REQ-PUB-08 trip deploy ships only the shareable site", () => {
  it("BUI-1590: the default deploy folder holds the story and no Studio or demo page", async () => {
    const root = await exportedProject(),
      run = vi.fn<(outputPath: string) => Promise<void>>(async () => {});
    await deploy(undefined, run);
    expect(run).toHaveBeenCalledOnce();
    const deployed = run.mock.calls[0]![0];
    expect(isAbsolute(deployed)).toBe(false);
    expect(scannedPaths).toEqual([deployed]);
    expectStoryOnly(await files(join(root, deployed)));
  });

  it("deploys an explicit folder unchanged", async () => {
    const root = await exportedProject(),
      run = vi.fn<(outputPath: string) => Promise<void>>(async () => {}),
      explicit = join(root, "out/site");
    await deploy(explicit, run);
    expect(run).toHaveBeenCalledExactlyOnceWith(explicit);
    expect(scannedPaths).toEqual([explicit]);
  });
});

// @verifies DES-PUB-EXPORT, ARCH-PUBLISH, REQ-PUB-08, SN-08
describe("REQ-PUB-08 static preview serves only the shareable site", () => {
  it("BUI-1591: preview:static serves the story and no Studio or demo page", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> },
      command = manifest.scripts["preview:static"]!.split(/\s+/);
    expect(command[0]).toBe("serve");
    const folder = command[1]!;
    expect(folder.startsWith("-")).toBe(false);
    expect(isAbsolute(folder)).toBe(false);
    const root = await exportedProject();
    expectStoryOnly(await files(join(root, folder)));
  });
});
