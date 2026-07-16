import { describe, expect, it, vi } from "vitest";
import { retry } from "@/lib/ai/provider";

describe("OpenAI retry policy", () => {
  it("does not retry deterministic client errors", async () => {
    const task = vi.fn().mockRejectedValue(Object.assign(new Error("invalid request"), { status: 400 }));
    await expect(retry(task)).rejects.toThrow("invalid request");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("retries rate limits and transient server errors", async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValue("ok");
    await expect(retry(task)).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });
});
