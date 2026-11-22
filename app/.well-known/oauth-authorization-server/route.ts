// RFC 8414 authorization server metadata for the hosted MCP sign-in (DES-WEB-MCP, @buildproven/mcp-oauth).
import { hostedOAuth } from "@/app/api/mcp/_hosted/oauth";

export function GET(request: Request) {
  return hostedOAuth().metadata(request);
}

export function OPTIONS() {
  return hostedOAuth().preflight();
}
