import { timingSafeEqual } from "node:crypto";

export function assertOperatorRequest(request: Request, secret = process.env.WANDERPAGE_OPERATOR_SECRET) {
  const authorization = request.headers.get("authorization"),
    expected = secret ? `Bearer ${secret}` : "";
  if (!secret || !authorization || !safeEqual(authorization, expected)) throw new Error("OPERATOR_AUTH_REQUIRED");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
