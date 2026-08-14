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

export { csrfHeaderName };
