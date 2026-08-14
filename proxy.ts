import { NextRequest, NextResponse } from "next/server";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64"),
    contentSecurityPolicy = [
      "default-src 'self'",
      "img-src 'self' data:",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://*.vercel-storage.com",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
    requestHeaders = new Headers(request.headers),
    owner = request.cookies.get(ownerCookieName)?.value;
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  if (owner) response.cookies.set(ownerCookieName, owner, ownerCookieOptions());
  return response;
}

export const config = {
  // API responses manage their own cache and credential behavior. Renew the
  // owner cookie only on document routes.
  matcher: ["/((?!api/|_next/static|_next/image|icon.svg).*)"],
};
