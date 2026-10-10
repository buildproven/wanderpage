/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Story from "@/components/Story";
import rawManifest from "@/data/trip.demo.json";
import { TripManifestSchema } from "@/lib/schemas/trip";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// @verifies DES-SITE-STORY, ARCH-SITE, REQ-UI-05, SN-08
describe("photo viewer", () => {
  let host: HTMLDivElement;
  let root: Root;

  const counter = () => host.querySelector(".lightbox-top > span")!.textContent ?? "";
  const press = (label: string) => act(() => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
  const touch = (type: "touchstart" | "touchend", x: number) =>
    act(() => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "changedTouches", { value: [{ clientX: x }] });
      host.querySelector(".lightbox-media")!.dispatchEvent(event);
    });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Story trip={TripManifestSchema.parse(rawManifest)} />));
    act(() => host.querySelector<HTMLElement>(".gallery-button")!.click());
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("advances on a timer while playing and stops when paused", () => {
    expect(counter()).toMatch(/^1 \//);
    press("Play slideshow");
    act(() => vi.advanceTimersByTime(4100));
    expect(counter()).toMatch(/^2 \//);
    press("Pause slideshow");
    act(() => vi.advanceTimersByTime(12000));
    expect(counter()).toMatch(/^2 \//);
  });

  it("stops the slideshow when the viewer is closed", () => {
    press("Play slideshow");
    press("Close lightbox");
    act(() => host.querySelector<HTMLElement>(".gallery-button")!.click());
    act(() => vi.advanceTimersByTime(12000));
    expect(counter()).toMatch(/^1 \//);
  });

  it("moves on a horizontal swipe and ignores a small touch", () => {
    touch("touchstart", 300);
    touch("touchend", 100);
    expect(counter()).toMatch(/^2 \//);
    touch("touchstart", 100);
    touch("touchend", 300);
    expect(counter()).toMatch(/^1 \//);
    touch("touchstart", 100);
    touch("touchend", 110);
    expect(counter()).toMatch(/^1 \//);
  });
});
