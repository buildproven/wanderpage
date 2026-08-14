import { describe, expect, it } from "vitest";
import { storyDto } from "@/lib/web/dto";

describe("story API DTO", () => {
  it("does not expose the IP-derived admission identifier", () => {
    const dto = storyDto({
      id: crypto.randomUUID(),
      ownerSessionId: crypto.randomUUID(),
      admissionKey: "private-correlation-hash",
      status: "uploading",
      title: "Private story",
      peopleMode: "exclude",
      locationPrivacy: "hidden",
      processorRevision: "web-v1",
      sourceExpiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 0,
    });
    expect(dto).not.toHaveProperty("admissionKey");
  });
});
