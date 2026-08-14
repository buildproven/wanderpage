import { describe, expect, it } from "vitest";
import { assertOperatorRequest } from "@/lib/web/operator-auth";

describe("operator authentication", () => {
  it("requires the exact configured bearer secret", () => {
    expect(() => assertOperatorRequest(new Request("https://example.test"), "operator-secret")).toThrow("OPERATOR_AUTH_REQUIRED");
    expect(() =>
      assertOperatorRequest(new Request("https://example.test", { headers: { authorization: "Bearer wrong" } }), "operator-secret")
    ).toThrow("OPERATOR_AUTH_REQUIRED");
    expect(() =>
      assertOperatorRequest(
        new Request("https://example.test", { headers: { authorization: "Bearer operator-secret" } }),
        "operator-secret"
      )
    ).not.toThrow();
  });
});
