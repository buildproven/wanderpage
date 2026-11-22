// @design DES-WEB-MCP
// Hosted MCP entry for Claude on the web, desktop and mobile. Only the owner's access token reaches a tool; the logic is in ./_hosted.
import { hostedMcpHandler } from "@/app/api/mcp/_hosted/runtime";

export function GET(request: Request) {
  return hostedMcpHandler(request);
}

export function POST(request: Request) {
  return hostedMcpHandler(request);
}

export function DELETE(request: Request) {
  return hostedMcpHandler(request);
}
