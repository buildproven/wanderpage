// @design DES-WEB-MCP
// Dynamic client registration (RFC 7591) (@buildproven/mcp-oauth).
import { hostedOAuth } from "@/app/api/mcp/_hosted/oauth";

export function POST(request: Request) {
  return hostedOAuth().register(request);
}

export function OPTIONS() {
  return hostedOAuth().preflight();
}
