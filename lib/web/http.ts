import { NextResponse } from "next/server";
import { StoryServiceError } from "@/lib/web/story-service";

export function data<T>(value: T, status = 200, init: ResponseInit = {}) {
  return NextResponse.json({ data: value }, { ...init, status });
}

export function apiError(error: unknown) {
  if (error instanceof StoryServiceError) {
    const status =
      error.code === "AUTH_REQUIRED"
        ? 401
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "VALIDATION_ERROR"
              ? 400
              : 409;
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  if (error instanceof SyntaxError)
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "The request body must be valid JSON." } }, { status: 400 });
  const message = error instanceof Error ? error.message : "Wanderpage is temporarily unavailable.";
  const configuration = /DATABASE_URL|WANDERPAGE_SESSION_PEPPER|BLOB_READ_WRITE_TOKEN|OPENAI_API_KEY|WORKFLOW/.test(message);
  return NextResponse.json(
    {
      error: {
        code: configuration ? "CONFIGURATION_ERROR" : "INTERNAL_ERROR",
        message: configuration ? "Wanderpage web creation is not configured yet." : "Wanderpage could not complete that request.",
      },
    },
    { status: configuration ? 503 : 500, headers: { "Cache-Control": "private, no-store" } }
  );
}

export function privateHeaders() {
  return { "Cache-Control": "private, no-store" };
}
