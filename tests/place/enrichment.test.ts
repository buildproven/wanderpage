import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichDestination } from "@/lib/enrichment/providers";
import type { DestinationEvidence } from "@/lib/location/infer";

afterEach(() => vi.unstubAllGlobals());

const destination = (confidence: number): DestinationEvidence => ({
  id: "destination-1",
  name: "Cannon Beach",
  confidence,
  lat: 45.89,
  lon: -123.96,
  photoIds: ["u-1"],
  evidence: ["1 photo(s) with nearby GPS metadata"],
});
const json = (value: unknown) => ({ ok: true, json: async () => value });

// @verifies DES-PLACE-ENRICH, REQ-LOC-04, ARCH-PLACE, SN-03, SN-07
describe("destination enrichment", () => {
  it("cites Wikipedia for every fact and adds historical weather", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("wikipedia.org")
          ? json({
              extract: "Cannon Beach is a city. It is known for Haystack Rock. It sits on the coast. Fourth sentence.",
              content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Cannon_Beach,_Oregon" } },
            })
          : json({ daily: { temperature_2m_max: [16.2], temperature_2m_min: [9.4], precipitation_sum: [0] } })
      )
    );
    const result = await enrichDestination(destination(0.9), "Wanderpage-test", "2026-09-04");
    expect(result.introduction).toBe("Cannon Beach is a city.");
    expect(result.facts).toHaveLength(2);
    expect(result.facts.every(fact => result.sources.some(source => source.id === fact.sourceId))).toBe(true);
    expect(result.sources[0]!.url).toBe("https://en.wikipedia.org/wiki/Cannon_Beach,_Oregon");
    expect(result.weather).toBe("9–16 °C");
  });

  it("degrades to a photo-led introduction when the source is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await enrichDestination(destination(0.9), "Wanderpage-test", "2026-09-04");
    expect(result.facts).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.introduction).toMatch(/external context was unavailable/);
  });

  it("does not look up or name a low-confidence destination", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await enrichDestination(destination(0.5), "Wanderpage-test");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.introduction).toMatch(/intentionally unlabeled/);
    expect(JSON.stringify(result)).not.toContain("Cannon Beach");
  });

  it("uses a generic region label for a moderately confident destination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await enrichDestination(destination(0.7), "Wanderpage-test");
    expect(result.introduction).toContain("the surrounding region");
    expect(result.introduction).not.toContain("Cannon Beach");
  });
});
