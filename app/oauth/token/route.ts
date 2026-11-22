// @design DES-WEB-MCP
// Token endpoint: authorization code with PKCE and refresh grants (@buildproven/mcp-oauth).
import { hostedOAuth } from "@/app/api/mcp/_hosted/oauth";

export function POST(request: Request) {
  return hostedOAuth().token(request);
}

export function OPTIONS() {
  return hostedOAuth().preflight();
}
