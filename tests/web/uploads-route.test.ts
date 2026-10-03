import { describe, expect, it } from "vitest";
import { blobClientResponse } from "@/lib/web/blob-response";

// @verifies DES-WEB-HTTP, DES-WEB-UPLOAD, ARCH-WEB-UPLOAD, REQ-WEB-03
describe("Blob client upload response", () => {
  it("returns the raw Blob token payload instead of the application envelope", async () => {
    const response = blobClientResponse({ type: "blob.generate-client-token", token: "opaque-token" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: "blob.generate-client-token", token: "opaque-token" });
  });
});
