import { createHash } from "node:crypto";
import { z } from "zod";
import { assertOperatorRequest } from "@/lib/web/operator-auth";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { apiError, privateHeaders } from "@/lib/web/http";
import { StoryServiceError } from "@/lib/web/story-service";

const storyIdSchema = z.string().uuid();
const attempts = new Map<string, { count: number; resetAt: number }>();

export async function DELETE(request: Request, context: { params: Promise<{ storyId: string }> }) {
  const now = new Date(),
    address = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    authorization = request.headers.get("authorization") ?? "missing",
    keyId = createHash("sha256").update(authorization).digest("hex").slice(0, 12);
  try {
    assertOperatorRequest(request);
    enforceRateLimit(`${keyId}:${address}`, now);
    const storyId = storyIdSchema.parse((await context.params).storyId),
      repository = NeonStoryRepository.fromEnvironment();
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
    if (error instanceof Error && error.message === "OPERATOR_RATE_LIMIT")
      return apiError(new StoryServiceError("INVALID_STATE", "Operator takedown rate limit reached. Try again shortly."));
    return apiError(error);
  }
}

function enforceRateLimit(key: string, now: Date) {
  const current = attempts.get(key);
  if (!current || current.resetAt <= now.getTime()) {
    attempts.set(key, { count: 1, resetAt: now.getTime() + 60_000 });
    return;
  }
  if (current.count >= 5) throw new Error("OPERATOR_RATE_LIMIT");
  current.count += 1;
}

function audit(event: Record<string, string>) {
  process.stdout.write(`${JSON.stringify({ event: "wanderpage.operator_takedown", ...event })}\n`);
}
