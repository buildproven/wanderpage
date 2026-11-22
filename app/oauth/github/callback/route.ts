// @design DES-WEB-MCP
// GitHub sign-in callback: issues an authorization code to the owner only (@buildproven/mcp-oauth).
import { hostedOAuth } from "@/app/api/mcp/_hosted/oauth";

export function GET(request: Request) {
  return hostedOAuth().githubCallback(request);
}
