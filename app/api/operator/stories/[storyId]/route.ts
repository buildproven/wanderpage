import { createHash } from "node:crypto";
import { z } from "zod";
import { assertOperatorRequest } from "@/lib/web/operator-auth";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { apiError, privateHeaders } from "@/lib/web/http";
import { StoryServiceError } from "@/lib/web/story-service";

const storyIdSchema = z.string().uuid();

export async function DELETE(request: Request, context: { params: Promise<{ storyId: string }> }) {
  const now = new Date(),
    address = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    authorization = request.headers.get("authorization") ?? "missing",
    keyId = createHash("sha256").update(authorization).digest("hex").slice(0, 12);
  try {
    assertOperatorRequest(request);
    const storyId = storyIdSchema.parse((await context.params).storyId),
      repository = NeonStoryRepository.fromEnvironment();
    const rateLimit = await repository.consumeOperatorTakedownLimit(keyId, now);
    if (!rateLimit.allowed) throw new OperatorRateLimitError(rateLimit.resetAt);
    await repository.beginOperatorDeleteStory(storyId, now);
    audit({ outcome: "accepted", storyId, keyId, address, at: now.toISOString() });
    return Response.json({ status: "deleting" }, { status: 202, headers: privateHeaders() });
  } catch (error) {
    audit({ outcome: "rejected", keyId, address, at: now.toISOString() });
    if (error instanceof Error && error.message === "OPERATOR_AUTH_REQUIRED")
      return apiError(new StoryServiceError("AUTH_REQUIRED", "Operator authentication failed."));
    if (error instanceof Error && error.message === "STORY_NOT_FOUND")
      return apiError(new StoryServiceError("NOT_FOUND", "Story not found."));
    if (error instanceof z.ZodError) return apiError(new StoryServiceError("VALIDATION_ERROR", "Story id must be a UUID."));
    if (error instanceof OperatorRateLimitError)
      return Response.json(
        { error: { code: "RATE_LIMITED", message: "Operator takedown rate limit reached. Try again shortly." } },
        {
          status: 429,
          headers: { ...privateHeaders(), "Retry-After": String(Math.max(1, Math.ceil((error.resetAt.getTime() - now.getTime()) / 1000))) },
        }
      );
    return apiError(error);
  }
}

class OperatorRateLimitError extends Error {
  constructor(readonly resetAt: Date) {
    super("OPERATOR_RATE_LIMIT");
  }
}

function audit(event: Record<string, string>) {
  process.stdout.write(`${JSON.stringify({ event: "wanderpage.operator_takedown", ...event })}\n`);
}
