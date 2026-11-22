// @design DES-WEB-MCP
// Authorization endpoint: starts the owner's sign-in with GitHub (@buildproven/mcp-oauth).
import { hostedOAuth } from "@/app/api/mcp/_hosted/oauth";

export function GET(request: Request) {
  return hostedOAuth().authorize(request);
}
