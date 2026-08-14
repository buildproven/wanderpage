import { NextRequest, NextResponse } from "next/server";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";

export function proxy(request: NextRequest) {
  const response = NextResponse.next(),
    owner = request.cookies.get(ownerCookieName)?.value;
  if (owner) response.cookies.set(ownerCookieName, owner, ownerCookieOptions());
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg).*)"],
};
