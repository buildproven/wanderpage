import { NextRequest, NextResponse } from "next/server";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";

export function proxy(request: NextRequest) {
  const response = NextResponse.next(),
    owner = request.cookies.get(ownerCookieName)?.value;
  if (owner) response.cookies.set(ownerCookieName, owner, ownerCookieOptions());
  return response;
}

export const config = {
  // API responses manage their own cache and credential behavior. Renew the
  // owner cookie only on document routes.
  matcher: ["/((?!api/|_next/static|_next/image|icon.svg).*)"],
};
