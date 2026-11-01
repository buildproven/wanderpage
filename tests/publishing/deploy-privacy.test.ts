import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deployAfterPrivacyScan, PrivacyScanError } from "@/lib/publishing/privacy";
import { deploy } from "@/scripts/deploy";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

// @verifies DES-PUB-PRIVACY, REQ-PUB-04, ARCH-PUBLISH, SN-03, SN-04
// Behavior under test: REQ-PRIV-1 (deploy refuses a site that fails the privacy scan), REQ-PRIV-2 (clean site deploys).

let workspace = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("deploy-privacy");
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});

async function fixture(name: string, leak: boolean) {
  const out = join(workspace, name);
  await mkdir(out, { recursive: true });
  const image = sharp({ create: { width: 64, height: 64, channels: 3, background: "#4d7f9a" } });
  if (leak) image.withExif({ IFD0: { Model: "Secret Camera 9000" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "45/1 52/1 4200/100" } });
  await image.jpeg().toFile(join(out, "photo.jpg"));
  await writeFile(join(out, "index.html"), leak ? "<p>/Users/alice/Pictures/trip/IMG_1.jpg</p>" : "<p>A clean trip</p>");
  return out;
}

describe("REQ-PRIV-1 deploy is gated by the privacy scan", () => {
  it("does not call deploy and lists every finding for a leaking site", async () => {
    const stub = vi.fn(async () => {});
    const result = await deployAfterPrivacyScan({ outputPath: await fixture("leaky", true), deploy: stub, secrets: [] });
    expect(stub).not.toHaveBeenCalled();
    expect(result.deployed).toBe(false);
    expect(result.findings.some(finding => finding.endsWith("photo.jpg: embedded metadata"))).toBe(true);
    expect(result.findings.some(finding => finding.includes("index.html: matched"))).toBe(true);
  });

  it("blocks a configured secret in the output", async () => {
    const out = await fixture("secret", false);
    await writeFile(join(out, "notes.txt"), "token sk-live-abcdefghijkl");
    const stub = vi.fn(async () => {});
    const result = await deployAfterPrivacyScan({ outputPath: out, deploy: stub, secrets: ["sk-live-abcdefghijkl"] });
    expect(stub).not.toHaveBeenCalled();
    expect(result.findings).toEqual([expect.stringContaining("contains a configured secret")]);
  });

  it("makes the CLI deploy entry point throw with each finding and never run the deployer", async () => {
    const run = vi.fn(async () => {});
    const error = await deploy(await fixture("cli-leaky", true), run).catch((caught: unknown) => caught);
    expect(run).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(PrivacyScanError);
    expect((error as PrivacyScanError).findings).toHaveLength(2);
    expect((error as Error).message).toContain("embedded metadata");
    expect((error as Error).message).toContain("index.html: matched");
  });

  it("propagates a missing output directory instead of deploying", async () => {
    const stub = vi.fn(async () => {});
    await expect(deployAfterPrivacyScan({ outputPath: join(workspace, "missing"), deploy: stub, secrets: [] })).rejects.toThrow();
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("REQ-PRIV-2 a clean site deploys as before", () => {
  it("calls deploy exactly once", async () => {
    const stub = vi.fn(async () => {});
    const result = await deployAfterPrivacyScan({ outputPath: await fixture("clean", false), deploy: stub, secrets: [] });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ deployed: true, findings: [] });
  });

  it("runs the CLI deployer once for a clean site", async () => {
    const run = vi.fn(async () => {});
    const outputPath = await fixture("cli-clean", false);
    await deploy(outputPath, run);
    expect(run).toHaveBeenCalledExactlyOnceWith(outputPath);
  });
});
