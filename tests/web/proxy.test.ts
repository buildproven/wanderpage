import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

describe("owner cookie renewal proxy", () => {
  it("renews an owner cookie on authenticated reads", () => {
    const response = proxy(
      new NextRequest("https://wanderpage.example/stories/story-id", {
        headers: { cookie: "wanderpage_owner=opaque-secret" },
      })
    );
    const renewed = response.cookies.get("wanderpage_owner");
    expect(renewed?.value).toBe("opaque-secret");
    expect(renewed?.maxAge).toBe(30 * 24 * 60 * 60);
  });
});
