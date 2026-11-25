// @design DES-SITE-LANDING
import { signupMode } from "@buildproven/mcp-oauth";
import Landing from "@/components/Landing";

// The hosted sign-in mode, read with the prefix WANDERPAGE that the hosted MCP entry passes to @buildproven/mcp-oauth (BUI-2215).
export default function Home() {
  return <Landing openSignup={signupMode("WANDERPAGE") === "open"} />;
}
