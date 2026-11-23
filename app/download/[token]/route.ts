// @design DES-WEB-MCP
// One-time download link from the hosted `download_page` tool; the logic is in app/api/mcp/_hosted/download-page.ts.
import { createDownloadHandlers, downloadLinkDependencies } from "@/app/api/mcp/_hosted/download-page";

export const dynamic = "force-dynamic";

const handlers = createDownloadHandlers(downloadLinkDependencies);

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  return handlers.GET(request, (await context.params).token);
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  return handlers.POST(request, (await context.params).token);
}
