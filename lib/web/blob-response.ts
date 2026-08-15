import { NextResponse } from "next/server";
import { privateHeaders } from "@/lib/web/http";

/**
 * The Blob client consumes this response directly. Unlike our application API
 * routes, it must not be wrapped in the `{ data: ... }` envelope.
 */
export function blobClientResponse(result: unknown) {
  return NextResponse.json(result, { status: 200, headers: privateHeaders() });
}
