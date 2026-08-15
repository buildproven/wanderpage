import { describe, expect, it } from "vitest";
import { blobClientResponse } from "@/app/api/uploads/route";

describe("Blob client upload response", () => {
  it("returns the raw Blob token payload instead of the application envelope", async () => {
    const response = blobClientResponse({ type: "blob.generate-client-token", token: "opaque-token" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: "blob.generate-client-token", token: "opaque-token" });
  });
});
