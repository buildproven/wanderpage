import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deployAfterPrivacyScan, PrivacyScanError } from "@/lib/publishing/privacy";
import { deploy } from "@/scripts/deploy";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

let workspace = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("deploy-privacy-requirements");
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function cleanSite(name: string) {
  const out = join(workspace, name);
  await mkdir(join(out, "trips", "lisbon"), { recursive: true });
  await sharp({ create: { width: 32, height: 32, channels: 3, background: "#7a9a4d" } })
    .webp()
    .toFile(join(out, "trips", "lisbon", "hero.webp"));
  await writeFile(join(out, "index.html"), "<p>A clean trip</p>");
  return out;
}

// @verifies REQ-PRIV-1, DES-PUB-PRIVACY
describe("REQ-PRIV-1 deploy refuses a site that fails the privacy scan", () => {
  it("scans with the environment's configured secrets when the caller passes none", async () => {
    const deployCredential = "vercel-credential-from-env";
    vi.stubEnv("VERCEL_TOKEN", deployCredential);
    vi.stubEnv("OPENAI_API_KEY", "");
    const out = await cleanSite("env-secret");
    await writeFile(join(out, "trips", "lisbon", "data.json"), JSON.stringify({ leaked: deployCredential }));
    const deployer = vi.fn(async () => {});
    const result = await deployAfterPrivacyScan({ outputPath: out, deploy: deployer });
    expect(deployer).not.toHaveBeenCalled();
    expect(result.deployed).toBe(false);
    expect(result.findings).toEqual([expect.stringMatching(/data\.json: contains a configured secret$/)]);
  });

  it("reports a finding for every leaking file, including files in nested folders", async () => {
    const out = await cleanSite("nested-leaks");
    await writeFile(join(out, "trips", "lisbon", "page.js"), 'const source = "/Users/alice/Pictures/IMG_2.jpg";');
    await writeFile(join(out, "sitemap.xml"), "<loc>.trip-cache/lisbon</loc>");
    const deployer = vi.fn(async () => {});
    const result = await deployAfterPrivacyScan({ outputPath: out, deploy: deployer, secrets: [] });
    expect(deployer).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(2);
    expect(result.findings.some(finding => finding.includes("page.js: matched"))).toBe(true);
    expect(result.findings.some(finding => finding.includes("sitemap.xml: matched"))).toBe(true);
  });

  it("makes the CLI deploy throw a PrivacyScanError for an environment secret and never run the deployer", async () => {
    const key = "sk-openai-from-env-abcdef";
    vi.stubEnv("OPENAI_API_KEY", key);
    const out = await cleanSite("cli-env-secret");
    await writeFile(join(out, "notes.txt"), `key ${key}`);
    const run = vi.fn(async () => {});
    const error = await deploy(out, run).catch((caught: unknown) => caught);
    expect(run).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(PrivacyScanError);
    expect((error as PrivacyScanError).findings).toEqual([expect.stringMatching(/notes\.txt: contains a configured secret$/)]);
    expect((error as Error).message).toContain("nothing was deployed");
  });
});

// @verifies REQ-PRIV-2, DES-PUB-PRIVACY
describe("REQ-PRIV-2 a clean site deploys once", () => {
  it("deploys a clean site with nested images once and counts every scanned file", async () => {
    const deployer = vi.fn(async () => {});
    const result = await deployAfterPrivacyScan({ outputPath: await cleanSite("clean-nested"), deploy: deployer, secrets: [] });
    expect(deployer).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deployed: true, files: 2, findings: [] });
  });

  it("lets a deployer failure reach the caller after a clean scan", async () => {
    const deployer = vi.fn(async () => {
      throw new Error("Vercel exited with code 1");
    });
    await expect(deployAfterPrivacyScan({ outputPath: await cleanSite("deploy-fails"), deploy: deployer, secrets: [] })).rejects.toThrow(
      "Vercel exited with code 1"
    );
    expect(deployer).toHaveBeenCalledTimes(1);
  });

  it("makes the CLI deploy return the clean scan result after running the deployer once", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("VERCEL_TOKEN", "");
    const run = vi.fn(async () => {});
    const outputPath = await cleanSite("cli-clean-result");
    await expect(deploy(outputPath, run)).resolves.toEqual({ deployed: true, files: 2, findings: [] });
    expect(run).toHaveBeenCalledExactlyOnceWith(outputPath);
  });
});
