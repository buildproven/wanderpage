import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContactSheet } from "@/lib/ai/contact-sheet";
import type { PhotoRecord } from "@/lib/photos/types";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/workspace";

const parse = vi.fn();
vi.mock("openai", () => ({
  default: class {
    responses = { parse };
  },
}));
const { MockAIProvider, OpenAIProvider } = await import("@/lib/ai/provider");

let workspace = "";
beforeAll(async () => {
  workspace = await createTempWorkspace("vision");
});
afterAll(async () => {
  if (workspace) await removeTempWorkspace(workspace);
});
beforeEach(() => parse.mockReset());

const analysis = (photoId: string) => ({
  photoId,
  containsPeople: false,
  peopleProminence: "none",
  aestheticScore: 80,
  storyScore: 70,
  landmarkValue: 60,
  emotionalValue: 40,
  uniquenessScore: 70,
  categories: ["landscape"],
  possibleLocations: [],
  captionSeed: "A quiet frame.",
});

// @verifies DES-VISION-SHEET, ARCH-VISION
describe("contact sheet", () => {
  it("composes one labeled 4×4 JPEG for up to sixteen photos", async () => {
    const root = join(workspace, "sheet");
    await mkdir(root, { recursive: true });
    const photos: PhotoRecord[] = [];
    for (let index = 0; index < 5; index++) {
      const analysisPath = join(root, `p${index}.jpg`);
      await sharp({ create: { width: 512, height: 340, channels: 3, background: { r: 40 * index, g: 90, b: 140 } } })
        .jpeg()
        .toFile(analysisPath);
      photos.push({ id: `u-${index}`, analysisPath } as PhotoRecord);
    }
    const output = await buildContactSheet(photos, join(root, "out", "sheet-1.jpg")),
      metadata = await sharp(output).metadata();
    expect(metadata.format).toBe("jpeg");
    expect([metadata.width, metadata.height]).toEqual([1200, 1000]);
  });
});

// @verifies DES-VISION-PROVIDER, REQ-AI-01, REQ-AI-03, ARCH-VISION, SN-02
describe("OpenAI vision request", () => {
  it("forbids identifying people, asks for structured output, and validates the reply", async () => {
    const sheet = join(workspace, "request.jpg");
    await writeFile(sheet, Buffer.from("jpeg"));
    parse.mockResolvedValue({ output_parsed: { photos: [analysis("u-1")] } });
    const result = await new OpenAIProvider().analyzeContactSheet(sheet, ["u-1"]);
    expect(result.map(item => item.photoId)).toEqual(["u-1"]);
    const request = parse.mock.calls[0]![0] as { input: Array<{ role: string; content: unknown }>; text: { format: { type: string } } };
    const system = String(request.input.find(message => message.role === "system")!.content);
    expect(system).toMatch(/Never identify people or infer identity, relationship, sensitive traits/);
    expect(request.text.format.type).toBe("json_schema");
  });

  it("rejects a reply that does not match the analysis schema", async () => {
    const sheet = join(workspace, "bad-reply.jpg");
    await writeFile(sheet, Buffer.from("jpeg"));
    parse.mockResolvedValue({ output_parsed: { photos: [{ photoId: "u-1" }] } });
    await expect(new OpenAIProvider().analyzeContactSheet(sheet, ["u-1"])).rejects.toThrow();
  });
});

// @verifies DES-VISION-PROVIDER, REQ-AI-04, ARCH-VISION, SN-06
describe("deterministic provider", () => {
  it("returns the same complete analysis every time without any network client", async () => {
    const provider = new MockAIProvider(),
      ids = ["a", "b", "c", "d"];
    const first = await provider.analyzeContactSheet("unused", ids);
    expect(first.map(item => item.photoId)).toEqual(ids);
    expect(await provider.analyzeContactSheet("unused", ids)).toEqual(first);
    expect(parse).not.toHaveBeenCalled();
    expect((await provider.generateNarrative("{}")).title).toBeTruthy();
  });
});
