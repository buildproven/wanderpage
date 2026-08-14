import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { OwnerSession } from "@/lib/web/types";

export const ownerCookieName = "wanderpage_owner";
const csrfHeaderName = "x-wanderpage-csrf";

export async function ownerSecret() {
  return (await cookies()).get(ownerCookieName)?.value;
}

export function setOwnerCookie(response: NextResponse, secret: string, session: OwnerSession) {
  void session;
  response.cookies.set(ownerCookieName, secret, ownerCookieOptions());
}

export function ownerCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 30 * 24 * 60 * 60 };
}

export function assertMutationRequest(request: Request, session: OwnerSession) {
  const origin = request.headers.get("origin"),
    expectedOrigin = new URL(request.url).origin,
    csrf = request.headers.get(csrfHeaderName);
  if (origin && origin !== expectedOrigin) throw new Error("FORBIDDEN_ORIGIN");
  if (!csrf || !safeEqual(csrf, session.csrfToken)) throw new Error("CSRF_INVALID");
}

export function assertInitialRequest(request: Request) {
  const origin = request.headers.get("origin"),
    expectedOrigin = new URL(request.url).origin,
    contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (origin !== expectedOrigin) throw new Error("FORBIDDEN_ORIGIN");
  if (contentType !== "application/json") throw new Error("INVALID_CONTENT_TYPE");
}

export function admissionKey(request: Request) {
  const pepper = process.env.WANDERPAGE_ADMISSION_PEPPER,
    forwarded =
      request.headers.get("x-vercel-forwarded-for") ??
      (process.env.NODE_ENV === "production" ? undefined : request.headers.get("x-forwarded-for")),
    address = forwarded?.split(",")[0]?.trim();
  if (!pepper || !address) throw new Error("WANDERPAGE_ADMISSION_PEPPER and a trusted client address are required for admission.");
  return createHmac("sha256", pepper).update(`generation:${address}`).digest("base64url");
}

export { csrfHeaderName };

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
