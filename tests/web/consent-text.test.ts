import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as consent from "@/lib/consent";
import DraftControls from "@/components/DraftControls";
import WebCreator from "@/components/WebCreator";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const uploadConsentText = (consent as { uploadConsentText?: string }).uploadConsentText ?? "";

function visibleText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function story(status: string) {
  return {
    id: "story-consent",
    title: "Harbour light",
    status,
    version: 1,
    peopleMode: "exclude" as const,
    locationPrivacy: "broad" as const,
  };
}

// @verifies DES-WEB-UI, DES-WEB-SESSION, ARCH-WEB-UI, REQ-WEB-02, REQ-WEB-07
describe("the upload consent text (BUI-2198)", () => {
  it("BUI-2198 R1: lib/consent.ts exports uploadConsentText naming 24 hours, 48 hours, OpenAI and 30 days", () => {
    expect(uploadConsentText).toContain("source uploads expiring after 24 hours and being automatically deleted within 48 hours");
    expect(uploadConsentText).toContain("derived contact-sheet processing by OpenAI");
    expect(uploadConsentText).toContain("automatic deletion of an unpublished draft after 30 days of inactivity");
    expect(consent.currentDisclosureVersion).toBeTruthy();
  });

  it("BUI-2198 R1: WebCreator renders uploadConsentText in its consent checkbox label", () => {
    expect(uploadConsentText).not.toBe("");
    const text = visibleText(renderToStaticMarkup(createElement(WebCreator)));
    expect(text).toContain(uploadConsentText);
  });

  it("BUI-2198 R2: an uploading story shows uploadConsentText before the file input", () => {
    expect(uploadConsentText).not.toBe("");
    const html = renderToStaticMarkup(createElement(DraftControls, { story: story("uploading"), csrfToken: "header-value" })),
      picker = html.indexOf('type="file"'),
      shown = visibleText(html.slice(0, picker));
    expect(picker).toBeGreaterThan(-1);
    expect(shown).toContain(uploadConsentText);
  });

  it("BUI-2198 R2: a story that is not uploading does not show the upload consent text", () => {
    expect(uploadConsentText).not.toBe("");
    for (const status of ["draft", "published", "failed", "queued"]) {
      const text = visibleText(renderToStaticMarkup(createElement(DraftControls, { story: story(status), csrfToken: "header-value" })));
      expect(text).not.toContain(uploadConsentText);
    }
  });
});

// @verifies DES-WEB-UI, ARCH-WEB-UI, REQ-WEB-02
describe("WebCreator keeps no copy of the upload consent text (BUI-2198)", () => {
  it("BUI-2198 R1: components/WebCreator.tsx imports uploadConsentText and does not repeat its words", async () => {
    const source = (await readFile("components/WebCreator.tsx", "utf8")).replace(/\s+/g, " ");
    expect(source).toContain("{uploadConsentText}");
    expect(source).not.toContain("48 hours");
    expect(source).not.toContain("30 days of inactivity");
  });
});
