// @design DES-WEB-HTTP
import { NextRequest, NextResponse } from "next/server";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";
import { ownerTtlCookieName, ownerTtlLinkValue } from "@/lib/web/upload-link";

// The browser creator was retired (BUI-2148): the Claude plugin is the only creator. Old links to /create land on the product page.
const retiredCreatorPath = /^\/create\/?$/;

export function proxy(request: NextRequest) {
  if (retiredCreatorPath.test(request.nextUrl.pathname)) return NextResponse.redirect(new URL("/", request.url), 308);
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
    // sets the cookie, so a renewal of an older cookie there would race the new one. A download link (BUI-2146) answers a file and
    // sets no cookie, so no cookie is renewed there either.
    renewable =
      request.cookies.get(ownerTtlCookieName)?.value !== ownerTtlLinkValue && !/^\/(upload|download)\//.test(request.nextUrl.pathname);
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
