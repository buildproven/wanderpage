import { afterEach, describe, expect, it, vi } from "vitest";
import { inferDestinations } from "@/lib/location/infer";
import type { PhotoRecord } from "@/lib/photos/types";

const photo = (id: string): PhotoRecord => ({
  id,
  hash: id,
  sourcePath: "/private/input.jpg",
  workingPath: "/cache/input.jpg",
  analysisPath: "/cache/analysis.jpg",
  width: 1200,
  height: 800,
  gps: { lat: 45, lon: -123 },
  technical: { sharpness: 80, exposure: 80, contrast: 80, colorBalance: 80, resolution: 80, noise: 80, clipping: 80, overall: 80 },
  perceptualHash: "0".repeat(16),
  rejectionReasons: [],
});

describe("destination inference", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the distance-bearing geosearch result only when it is close enough", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ query: { geosearch: [{ title: "Supported place", dist: 240 }] } })));
    vi.stubGlobal("fetch", fetch);

    const destinations = await inferDestinations([photo("one")], "Wanderpage test");

    expect(destinations[0]).toMatchObject({ name: "Supported place", confidence: 0.84 });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("list")).toBe("geosearch");
    expect(url.searchParams.get("gslimit")).toBe("1");
    expect(url.searchParams.get("gsradius")).toBe("500");
  });

  it("omits a specific place name when the nearest result is too far away", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ query: { geosearch: [{ title: "Too far away", dist: 501 }] } })))
    );

    const destinations = await inferDestinations([photo("one")], "Wanderpage test");

    expect(destinations[0]).toMatchObject({ name: "Region 1", confidence: 0.5 });
  });
});
