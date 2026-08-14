import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/media/[storyId]/[filename]/route";

describe("private media route", () => {
  it("rejects a filename that changes during sanitization before storage access", async () => {
    const response = await GET(new Request("https://wander.page/api/media/story-1/..%2Fsecret.jpg"), {
      params: Promise.resolve({ storyId: "story-1", filename: "../secret.jpg" }),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });
});
