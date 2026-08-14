import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { OwnerSession } from "@/lib/web/types";

export const ownerCookieName = "wanderpage_owner";
const csrfHeaderName = "x-wanderpage-csrf";

export async function ownerSecret() {
  return (await cookies()).get(ownerCookieName)?.value;
}

export function setOwnerCookie(response: NextResponse, secret: string, session: OwnerSession) {
  response.cookies.set(ownerCookieName, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
}

export function assertMutationRequest(request: Request, session: OwnerSession) {
  const origin = request.headers.get("origin"),
    expectedOrigin = new URL(request.url).origin,
    csrf = request.headers.get(csrfHeaderName);
  if (origin && origin !== expectedOrigin) throw new Error("FORBIDDEN_ORIGIN");
  if (!csrf || csrf !== session.csrfToken) throw new Error("CSRF_INVALID");
}

export function admissionKey(request: Request) {
  const pepper = process.env.WANDERPAGE_SESSION_PEPPER,
    forwarded =
      request.headers.get("x-vercel-forwarded-for") ??
      (process.env.NODE_ENV === "production" ? undefined : request.headers.get("x-forwarded-for")),
    address = forwarded?.split(",")[0]?.trim();
  if (!pepper || !address) throw new Error("WANDERPAGE_SESSION_PEPPER and a trusted client address are required for admission.");
  return createHmac("sha256", pepper).update(`generation:${address}`).digest("base64url");
}

export { csrfHeaderName };
import { createHmac } from "node:crypto";
