import { describe, expect, it } from "vitest";
import { hammingDistance } from "@/lib/photos/scoring";
import { targetCount } from "@/lib/selection/select";
import { roundedCoordinate } from "@/lib/location/infer";

describe("deterministic photo pipeline", () => {
  // @verifies DES-PHOTO-SCORE
  it("measures perceptual hash distance", () => {
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
  });
  // @verifies DES-SELECT-EDIT
  it("clamps the editorial selection target", () => {
    expect(targetCount(50, 36)).toBe(18);
    expect(targetCount(500, 36)).toBe(36);
    expect(targetCount(10, 36)).toBe(10);
  });
  // @verifies DES-PLACE-INFER, REQ-LOC-02, SN-03
  it("never exposes source precision in approximate mode", () => {
    expect(roundedCoordinate(45.123456, "approximate")).toBe(45.1);
    expect(roundedCoordinate(-123.987654, "precise")).toBe(-123.99);
  });
});
