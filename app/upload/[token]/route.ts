// @design DES-WEB-MCP
// One-time upload link from the hosted `upload_photos` tool; the logic is in app/api/mcp/_hosted/upload-page.ts.
import { createUploadLinkHandlers, uploadLinkDependencies } from "@/app/api/mcp/_hosted/upload-page";

export const dynamic = "force-dynamic";

const handlers = createUploadLinkHandlers(uploadLinkDependencies);

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  return handlers.GET(request, (await context.params).token);
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  return handlers.POST(request, (await context.params).token);
}
