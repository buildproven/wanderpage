import { describe, expect, it } from "vitest";
import { assertPreviewUrl, readPreviewRunMode } from "@/lib/web/preview-policy";

describe("hosted preview acceptance policy", () => {
  it("accepts a Vercel preview URL", () => {
    expect(assertPreviewUrl("https://wanderpage-git-preview.vercel.app").hostname).toBe("wanderpage-git-preview.vercel.app");
  });

  it("blocks production and local URLs", () => {
    expect(() => assertPreviewUrl("https://wanderpage.buildproven.ai")).toThrow(/Production/);
    expect(() => assertPreviewUrl("http://localhost:3000")).toThrow(/HTTPS/);
  });

  it("requires an explicit allowlist for a non-Vercel preview host", () => {
    expect(() => assertPreviewUrl("https://preview.example.test")).toThrow(/allowlist/);
    expect(assertPreviewUrl("https://preview.example.test", ["preview.example.test"]).hostname).toBe("preview.example.test");
  });

  it("requires preview confirmation and exactly one mode", () => {
    expect(() => readPreviewRunMode({})).toThrow(/preview-only/);
    expect(() => readPreviewRunMode({ WANDERPAGE_PREVIEW_CONFIRM: "preview-only" })).toThrow(/exactly one/);
    expect(() =>
      readPreviewRunMode({ WANDERPAGE_PREVIEW_CONFIRM: "preview-only", WANDERPAGE_HOSTED_SMOKE: "1", WANDERPAGE_HOSTED_ACCEPTANCE: "1" })
    ).toThrow(/exactly one/);
    expect(readPreviewRunMode({ WANDERPAGE_PREVIEW_CONFIRM: "preview-only", WANDERPAGE_HOSTED_SMOKE: "1" })).toBe("smoke");
  });

  it("requires an explicit generation consent for full acceptance", () => {
    expect(() => readPreviewRunMode({ WANDERPAGE_PREVIEW_CONFIRM: "preview-only", WANDERPAGE_HOSTED_ACCEPTANCE: "1" })).toThrow(
      /ALLOW_GENERATION/
    );
    expect(
      readPreviewRunMode({
        WANDERPAGE_PREVIEW_CONFIRM: "preview-only",
        WANDERPAGE_HOSTED_ACCEPTANCE: "1",
        WANDERPAGE_HOSTED_ALLOW_GENERATION: "1",
      })
    ).toBe("acceptance");
  });
});
