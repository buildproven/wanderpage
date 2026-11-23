// @design DES-WEB-HTTP
import { NextRequest, NextResponse } from "next/server";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";
import { ownerTtlCookieName, ownerTtlLinkValue } from "@/lib/web/upload-link";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64"),
    contentSecurityPolicy = [
      "default-src 'self'",
      "img-src 'self' data:",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://vercel.com https://*.vercel-storage.com",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
    requestHeaders = new Headers(request.headers),
    owner = request.cookies.get(ownerCookieName)?.value,
    // An upload link sets a 1-hour owner cookie with a marker (BUI-2095): renewing it would extend it to 30 days. The link page itself
    // sets the cookie, so a renewal of an older cookie there would race the new one.
    renewable = request.cookies.get(ownerTtlCookieName)?.value !== ownerTtlLinkValue && !request.nextUrl.pathname.startsWith("/upload/");
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  if (owner && renewable) response.cookies.set(ownerCookieName, owner, ownerCookieOptions());
  return response;
}

export const config = {
  // API responses manage their own cache and credential behavior. Renew the
  // owner cookie only on document routes.
  matcher: ["/((?!api/|_next/static|_next/image|icon.svg).*)"],
};
