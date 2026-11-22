// RFC 9728 protected resource metadata (DES-WEB-MCP): the 401 from /api/mcp points here, and the client reads which server signs it in.
import { protectedResourceMetadata } from "@/app/api/mcp/_hosted/http";

export function GET(request: Request) {
  return protectedResourceMetadata(request);
}
