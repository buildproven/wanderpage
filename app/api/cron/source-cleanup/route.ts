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
    sources = await cleanupExpiredSources(repository),
    derivatives = await cleanupFailedDerivatives(repository),
    stories = await cleanupExpiredPrivateStories(repository);
  return Response.json({ sources, derivatives, stories }, { headers: { "Cache-Control": "no-store" } });
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
