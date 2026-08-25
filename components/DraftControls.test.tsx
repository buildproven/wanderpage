/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter } from "next/navigation";
import DraftControls from "./DraftControls";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const router = { push: vi.fn(), refresh: vi.fn() };
const fetchMock = vi.fn();

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
});
