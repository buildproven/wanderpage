// @design DES-WEB-MCP
// Public keys that verify the access tokens (@buildproven/mcp-oauth).
import { hostedOAuth } from "@/app/api/mcp/_hosted/oauth";

export function GET(request: Request) {
  return hostedOAuth().jwks(request);
}

export function OPTIONS() {
  return hostedOAuth().preflight();
}
