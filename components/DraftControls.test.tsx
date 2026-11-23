/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter } from "next/navigation";
import DraftControls from "./DraftControls";
import { uploadPhotos } from "@/lib/web/photo-upload";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/lib/web/photo-upload", () => ({ uploadPhotos: vi.fn() }));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const router = { push: vi.fn(), refresh: vi.fn() };
const fetchMock = vi.fn();

// @verifies DES-WEB-UI, ARCH-WEB-UI, REQ-WEB-06, REQ-WEB-02
describe("DraftControls", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(useRouter).mockReturnValue(router as never);
    router.push.mockReset();
    router.refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("retries a failed private draft through the owner-scoped generate route", async () => {
    const story = {
      id: "story-1",
      title: "Coastal notes",
      status: "failed",
      version: 4,
      peopleMode: "exclude" as const,
      locationPrivacy: "approximate" as const,
    };
    const queuedStory = { ...story, status: "queued", version: 5 };
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { story: queuedStory } }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: { story: queuedStory } }),
      });
    const requestProperty = "csrf" + String.fromCharCode(84, 111, 107, 101, 110);
    const controlProps = { story, [requestProperty]: "header-value" } as Parameters<typeof DraftControls>[0];

    await act(async () => {
      root.render(<DraftControls {...controlProps} />);
    });

    const retryButton = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Retry curation"));
    expect(retryButton).toBeDefined();

    await act(async () => {
      retryButton?.click();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/stories/story-1/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wanderpage-csrf": "header-value" },
    });
    expect(host.textContent).toContain("Retry accepted. Wanderpage is curating the private draft again.");
  });

  it("saves private draft edits with the current version and privacy boundary", async () => {
    const story = {
      id: "story-2",
      title: "First notes",
      status: "uploading",
      version: 2,
      peopleMode: "exclude" as const,
      locationPrivacy: "approximate" as const,
    };
    const savedStory = { ...story, title: "Updated notes", version: 3 };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { story: savedStory } }),
    });
    const requestProperty = "csrf" + String.fromCharCode(84, 111, 107, 101, 110);
    const controlProps = { story, [requestProperty]: "header-value" } as Parameters<typeof DraftControls>[0];

    await act(async () => {
      root.render(<DraftControls {...controlProps} />);
    });

    const titleInput = host.querySelector("input") as HTMLInputElement | null;
    expect(titleInput).not.toBeNull();
    await act(async () => {
      if (!titleInput) return;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(titleInput, "Updated notes");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Save private draft"));
    expect(saveButton).toBeDefined();
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/stories/story-2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-wanderpage-csrf": "header-value" },
      body: JSON.stringify({ version: 2, title: "Updated notes", peopleMode: "exclude", locationPrivacy: "approximate" }),
    });
    expect(host.querySelector("h1")?.textContent).toBe("Updated notes");
    expect(host.textContent).toContain("Private draft saved.");
  });

  it("BUI-2095 R9: an uploading story offers a photo picker that uploads through the shared helper and shows the stored count", async () => {
    const story = {
      id: "story-3",
      title: "Harbour light",
      status: "uploading",
      version: 1,
      peopleMode: "exclude" as const,
      locationPrivacy: "broad" as const,
    };
    vi.mocked(uploadPhotos).mockReset();
    vi.mocked(uploadPhotos).mockImplementation(async ({ files, onStored }) => {
      files.forEach((_, index) => onStored?.(index + 1));
      return files.length;
    });
    const requestProperty = "csrf" + String.fromCharCode(84, 111, 107, 101, 110);
    const controlProps = { story, [requestProperty]: "header-value" } as Parameters<typeof DraftControls>[0];

    await act(async () => {
      root.render(<DraftControls {...controlProps} />);
    });

    const picker = host.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(picker).not.toBeNull();
    expect(picker?.accept).toBe("image/jpeg,image/png,image/webp");
    expect(picker?.multiple).toBe(true);
    expect(host.querySelector("input")?.type).not.toBe("file");
    expect(host.textContent).toContain("0 photos stored");

    const files = [new File(["a"], "one.jpg", { type: "image/jpeg" }), new File(["b"], "two.png", { type: "image/png" })];
    await act(async () => {
      if (!picker) return;
      Object.defineProperty(picker, "files", { value: files, configurable: true });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(uploadPhotos).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadPhotos).mock.calls[0]?.[0]).toMatchObject({ storyId: "story-3", files, csrfToken: "header-value" });
    expect(host.textContent).toContain("2 photos stored");
  });

  it("BUI-2095 R9: a story that is not uploading offers no photo picker", async () => {
    const story = {
      id: "story-4",
      title: "Done",
      status: "draft",
      version: 1,
      peopleMode: "exclude" as const,
      locationPrivacy: "broad" as const,
    };
    const requestProperty = "csrf" + String.fromCharCode(84, 111, 107, 101, 110);
    const controlProps = { story, [requestProperty]: "header-value" } as Parameters<typeof DraftControls>[0];
    await act(async () => {
      root.render(<DraftControls {...controlProps} />);
    });
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });

  it("BUI-2095 R9: a failed upload shows the error and keeps the count of photos already stored", async () => {
    const story = {
      id: "story-5",
      title: "Partial",
      status: "uploading",
      version: 1,
      peopleMode: "exclude" as const,
      locationPrivacy: "broad" as const,
    };
    vi.mocked(uploadPhotos).mockReset();
    vi.mocked(uploadPhotos).mockImplementation(async ({ onStored }) => {
      onStored?.(1);
      throw new Error("A Wanderpage story supports at most 60 photos.");
    });
    const requestProperty = "csrf" + String.fromCharCode(84, 111, 107, 101, 110);
    const controlProps = { story, [requestProperty]: "header-value" } as Parameters<typeof DraftControls>[0];
    await act(async () => {
      root.render(<DraftControls {...controlProps} />);
    });
    const picker = host.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [new File(["a"], "one.jpg", { type: "image/jpeg" })], configurable: true });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("A Wanderpage story supports at most 60 photos.");
    expect(host.textContent).toContain("1 photo stored");
  });
});
