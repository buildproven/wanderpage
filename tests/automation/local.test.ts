import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCommandError, drafts, publishDraft, readDraft, validateDraft } from "@/lib/automation/local";
import { copySiteScaffold, createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

const workspaces: string[] = [];
afterEach(async () => Promise.all(workspaces.splice(0).map(removeTempWorkspace)));

// @verifies DES-CLI-AGENT, ARCH-AGENT
describe("agent-ready local contract", () => {
  // @verifies REQ-CLI-05, SN-09
  it("validates and publishes only a private workspace draft", async () => {
    const root = await fixture();
    const before = await readFile(join(root, "data/trips/fixture-trip.json"), "utf8");
    const validation = await validateDraft(root, "fixture-trip");
    expect(validation.manifest.published).toBe(false);
    expect(validation.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validation.assetTreeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(root, "data/trips/fixture-trip.json"), "utf8")).toBe(before);
    expect(await publishDraft(root, "fixture-trip", true)).toMatchObject({ manifest: { published: true } });
    expect(await drafts(root)).toEqual([{ slug: "fixture-trip", title: "Fixture Trip", published: true }]);
  });

  // @verifies REQ-CLI-04, SN-09
  it("rejects traversal rather than reading outside the workspace", async () => {
    const root = await fixture();
    await expect(readDraft(root, "../trip.demo")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" } satisfies Partial<LocalCommandError>);
  });
});

async function fixture() {
  const root = await createTempWorkspace("automation");
  workspaces.push(root);
  await copySiteScaffold(root);
  const demo = JSON.parse(await readFile(join(root, "data/trip.demo.json"), "utf8"));
  await mkdir(join(root, "data/trips"), { recursive: true });
  await mkdir(join(root, ".trip-assets/fixture-trip"), { recursive: true });
  await cp(join(root, "public/trip/demo/coast-hero-thumb.webp"), join(root, ".trip-assets/fixture-trip/photo.webp"));
  await writeFile(
    join(root, "data/trips/fixture-trip.json"),
    JSON.stringify({ ...demo, title: "Fixture Trip", published: false }, null, 2)
  );
  return root;
}
