import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { assertInitialRequest } from "@/lib/web/session";

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

describe("initial story request", () => {
  it("requires same-origin JSON before creating an anonymous owner", () => {
    expect(() =>
      assertInitialRequest(
        new Request("https://wanderpage.example/api/stories", {
          method: "POST",
          headers: { origin: "https://attacker.example", "content-type": "application/json" },
        })
      )
    ).toThrow("FORBIDDEN_ORIGIN");
    expect(() =>
      assertInitialRequest(
        new Request("https://wanderpage.example/api/stories", {
          method: "POST",
          headers: { origin: "https://wanderpage.example", "content-type": "text/plain" },
        })
      )
    ).toThrow("INVALID_CONTENT_TYPE");
  });
});
