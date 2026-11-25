// @design DES-SITE-LANDING
// The landing page says who can sign in from `WANDERPAGE_SIGNUP` (BUI-2215), read by @buildproven/mcp-oauth with the prefix the hosted
// MCP entry passes (`hostedPrefix`, app/api/mcp/_hosted/http.ts; not imported, so this page does not bundle the MCP server). The root
// layout is force-dynamic, so each request reads the current setting.
import { signupMode } from "@buildproven/mcp-oauth";
import Landing from "@/components/Landing";

export default function Home() {
  return <Landing signup={signupMode("WANDERPAGE")} />;
}
