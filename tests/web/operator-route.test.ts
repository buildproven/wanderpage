import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeOperatorTakedownLimit: vi.fn(),
  beginOperatorDeleteStory: vi.fn(),
}));

vi.mock("@/lib/web/operator-auth", () => ({ assertOperatorRequest: vi.fn() }));
vi.mock("@/lib/web/neon-repository", () => ({ NeonStoryRepository: { fromEnvironment: () => mocks } }));

import { DELETE } from "@/app/api/operator/stories/[storyId]/route";

describe("operator takedown route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the shared key limit and returns retry guidance", async () => {
    mocks.consumeOperatorTakedownLimit.mockResolvedValue({ allowed: false, resetAt: new Date(Date.now() + 30_000) });
    const response = await DELETE(
      new Request("https://wanderpage.example/api/operator/stories/5441da36-2f79-4f27-bf5c-c70845008f64", {
        method: "DELETE",
        headers: { authorization: "Bearer operator-secret", "x-vercel-forwarded-for": "192.0.2.1" },
      }),
      { params: Promise.resolve({ storyId: "5441da36-2f79-4f27-bf5c-c70845008f64" }) }
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(mocks.consumeOperatorTakedownLimit).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{12}$/), expect.any(Date));
    expect(mocks.beginOperatorDeleteStory).not.toHaveBeenCalled();
  });
});
