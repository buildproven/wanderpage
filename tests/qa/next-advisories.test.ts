import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// GHSA-2464-fhr4-w9xw and the `use cache` RCE affect next >=16.0.0 <=16.4.0; first fix is 16.4.1.
const FIRST_PATCHED = [16, 4, 1];

const parse = (version: string) => version.split("-")[0]!.split(".").map(Number);

function isBelow(version: number[], floor: number[]): boolean {
  for (let i = 0; i < floor.length; i += 1) {
    if (version[i] !== floor[i]) return version[i]! < floor[i]!;
  }
  return false;
}

// @verifies ARCH-RELEASE, REQ-REL-01, SN-11
describe("next dependency", () => {
  it("is outside the critical Next.js RCE ranges", () => {
    const require = createRequire(import.meta.url);
    const { version } = JSON.parse(readFileSync(require.resolve("next/package.json"), "utf8")) as { version: string };
    expect(isBelow(parse(version), FIRST_PATCHED)).toBe(false);
  });

  it("treats 16.4.0 as vulnerable and 16.4.1 as patched", () => {
    expect(isBelow(parse("16.4.0"), FIRST_PATCHED)).toBe(true);
    expect(isBelow(parse("16.4.1"), FIRST_PATCHED)).toBe(false);
  });
});
