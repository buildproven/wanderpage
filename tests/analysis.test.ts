import { describe, expect, it } from "vitest";
import { requireCompleteContactSheetAnalysis, type PhotoSemanticAnalysis } from "@/lib/schemas/analysis";

const analysis = (photoId: string): PhotoSemanticAnalysis => ({
  photoId,
  containsPeople: false,
  peopleProminence: "none",
  aestheticScore: 80,
  storyScore: 80,
  landmarkValue: 80,
  emotionalValue: 80,
  uniquenessScore: 80,
  categories: ["landscape"],
  possibleLocations: [],
  captionSeed: "Visible landscape.",
});

describe("contact-sheet analysis", () => {
  it("rejects an incomplete response instead of leaving a photo unclassified", () => {
    expect(() => requireCompleteContactSheetAnalysis([analysis("one")], ["one", "two"])).toThrow(/missing: two/);
  });

  it("rejects duplicate and unexpected analysis IDs", () => {
    expect(() => requireCompleteContactSheetAnalysis([analysis("one"), analysis("one")], ["one", "two"])).toThrow(
      /missing: two; duplicate: one/
    );
    expect(() => requireCompleteContactSheetAnalysis([analysis("one"), analysis("other")], ["one", "two"])).toThrow(
      /missing: two; unexpected: other/
    );
  });
});
