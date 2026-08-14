import { timingSafeEqual } from "node:crypto";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { cleanupExpiredSources } from "@/lib/web/source-cleanup";
import { cleanupFailedDerivatives } from "@/lib/web/object-cleanup";
import { cleanupExpiredPrivateStories } from "@/lib/web/story-retention";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET,
    authorization = request.headers.get("authorization"),
    expected = secret ? `Bearer ${secret}` : "";
  if (!secret || !authorization || !safeEqual(authorization, expected)) return new Response("Unauthorized", { status: 401 });
  const repository = NeonStoryRepository.fromEnvironment(),
    sources = await settle(() => cleanupExpiredSources(repository)),
    derivatives = await settle(() => cleanupFailedDerivatives(repository)),
    stories = await settle(() => cleanupExpiredPrivateStories(repository)),
    failed = [sources, derivatives, stories].some(result => !result.ok) || (sources.ok && sources.value.failures.length > 0);
  return Response.json({ sources, derivatives, stories }, { status: failed ? 207 : 200, headers: { "Cache-Control": "no-store" } });
}

async function settle<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Cleanup operation failed." };
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
