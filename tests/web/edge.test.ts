import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, data, privateHeaders } from "@/lib/web/http";
import { admissionKey, assertMutationRequest, ownerCookieName, ownerCookieOptions } from "@/lib/web/session";
import { StoryServiceError } from "@/lib/web/story-service";
import type { OwnerSession } from "@/lib/web/types";

afterEach(() => vi.unstubAllEnvs());

const body = async (response: Response) => (await response.json()) as { data?: unknown; error?: { code: string; message: string } };

// @verifies DES-WEB-HTTP, ARCH-WEB-EDGE, REQ-WEB-09, SN-10
describe("hosted error mapping", () => {
  it.each([
    ["AUTH_REQUIRED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["VALIDATION_ERROR", 400],
    ["INVALID_STATE", 409],
    ["STORY_VERSION_CONFLICT", 409],
  ] as const)("maps %s to HTTP %i without caching", async (code, status) => {
    const response = apiError(new StoryServiceError(code, "message"));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await body(response)).error).toEqual({ code, message: "message" });
  });

  it("reports a missing service as a configuration error without echoing internals", async () => {
    const response = apiError(new Error("DATABASE_URL is required for web story storage."));
    expect(response.status).toBe(503);
    const payload = await body(response);
    expect(payload.error).toEqual({ code: "CONFIGURATION_ERROR", message: "Wanderpage web creation is not configured yet." });
    expect(JSON.stringify(payload)).not.toContain("DATABASE_URL");
  });

  it("hides unexpected errors and rejects malformed JSON and unverifiable requests", async () => {
    expect((await body(apiError(new Error("secret stack detail")))).error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Wanderpage could not complete that request.",
    });
    expect(apiError(new SyntaxError("Unexpected token")).status).toBe(400);
    expect(apiError(new Error("CSRF_INVALID")).status).toBe(403);
    expect(apiError(new Error("INVALID_CONTENT_TYPE")).status).toBe(400);
  });

  it("wraps data in an envelope and marks it private", async () => {
    expect(await body(data({ ok: true }, 201))).toEqual({ data: { ok: true } });
    expect(privateHeaders()).toEqual({ "Cache-Control": "private, no-store" });
  });
});

const session = { csrfToken: "csrf-token-value" } as OwnerSession;
const mutation = (headers: Record<string, string>) => new Request("https://wanderpage.example/api/stories/1", { method: "POST", headers });

// @verifies DES-WEB-SESSION, ARCH-WEB-EDGE, REQ-WEB-10, REQ-WEB-01, SN-10
describe("owner session guards", () => {
  it("accepts a same-origin mutation that carries the session's CSRF token", () => {
    expect(() =>
      assertMutationRequest(mutation({ origin: "https://wanderpage.example", "x-wanderpage-csrf": "csrf-token-value" }), session)
    ).not.toThrow();
  });

  it("rejects a foreign origin, a missing token, and a wrong token", () => {
    expect(() =>
      assertMutationRequest(mutation({ origin: "https://evil.example", "x-wanderpage-csrf": "csrf-token-value" }), session)
    ).toThrow("FORBIDDEN_ORIGIN");
    expect(() => assertMutationRequest(mutation({ origin: "https://wanderpage.example" }), session)).toThrow("CSRF_INVALID");
    expect(() =>
      assertMutationRequest(mutation({ origin: "https://wanderpage.example", "x-wanderpage-csrf": "csrf-token-valuX" }), session)
    ).toThrow("CSRF_INVALID");
  });

  it("stores the owner secret in an httpOnly, lax, 30-day cookie that is secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(ownerCookieName).toBe("wanderpage_owner");
    expect(ownerCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 60 * 60 });
  });

  it("derives an opaque admission key from a trusted address and refuses to run without a pepper", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WANDERPAGE_ADMISSION_PEPPER", "pepper-value-for-tests");
    const request = (address: string) =>
      new Request("https://wanderpage.example/api/stories", { headers: { "x-vercel-forwarded-for": address } });
    const key = admissionKey(request("203.0.113.9"));
    expect(key).not.toContain("203.0.113.9");
    expect(admissionKey(request("203.0.113.9"))).toBe(key);
    expect(admissionKey(request("203.0.113.10"))).not.toBe(key);
    expect(() => admissionKey(new Request("https://wanderpage.example/", { headers: { "x-forwarded-for": "203.0.113.9" } }))).toThrow(
      /trusted client address/
    );
    vi.stubEnv("WANDERPAGE_ADMISSION_PEPPER", "");
    expect(() => admissionKey(request("203.0.113.9"))).toThrow(/WANDERPAGE_ADMISSION_PEPPER/);
  });
});
