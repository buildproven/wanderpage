import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repository: {} as Record<string, ReturnType<typeof vi.fn>>,
  deleteObject: vi.fn(),
  cleanupDerivatives: vi.fn(),
  processStory: vi.fn(),
  validateHostedStoryOutput: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ del: mocks.deleteObject }));
vi.mock("@/lib/web/neon-repository", () => ({ NeonStoryRepository: { fromEnvironment: () => mocks.repository } }));
vi.mock("@/lib/web/object-cleanup", () => ({ cleanupRunDerivatives: mocks.cleanupDerivatives }));
vi.mock("@/lib/web/processor", () => ({
  processStory: mocks.processStory,
  validateHostedStoryOutput: mocks.validateHostedStoryOutput,
}));

import { processStoryWorkflow } from "@/workflows/process-story";

describe("story workflow recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const upload = { id: "upload-1", blobPath: "sources/story/upload-1", status: "rejected" };
    mocks.repository = {
      findStory: vi.fn(),
      findRun: vi.fn(),
      listUploadsByIds: vi.fn(async () => [upload]),
      saveUpload: vi.fn(),
    };
    mocks.deleteObject.mockRejectedValue(new Error("source storage unavailable"));
  });

  for (const status of ["draft", "published"] as const)
    it(`does not delete completed derivatives when ${status} source cleanup fails`, async () => {
      mocks.repository.findStory!.mockResolvedValue({ id: "story", status, activeRunId: undefined });
      mocks.repository.findRun!.mockResolvedValue({
        id: "run",
        storyId: "story",
        status: "complete",
        sourceUploadIds: ["upload-1"],
      });
      await expect(processStoryWorkflow("story", "run")).rejects.toThrow("source storage unavailable");
      expect(mocks.cleanupDerivatives).not.toHaveBeenCalled();
      expect(mocks.repository.saveUpload).not.toHaveBeenCalled();
    });

  it("records a typed fatal failure before completion when hosted privacy validation fails", async () => {
    const story = { id: "story", status: "processing", activeRunId: "run", version: 1 },
      run = { id: "run", storyId: "story", status: "processing", sourceUploadIds: ["upload-1"] };
    mocks.repository = {
      findStory: vi.fn(async () => story),
      findRun: vi.fn(async () => run),
      claimRun: vi.fn(),
      markRunProgress: vi.fn(),
      listUploadsByIds: vi.fn(async () => []),
      saveRun: vi.fn(),
      saveStory: vi.fn(),
    };
    mocks.processStory.mockResolvedValue({ manifest: { schemaVersion: "1.0" } });
    mocks.validateHostedStoryOutput.mockRejectedValue(new Error("PRIVACY_FAILED: derivative contains embedded metadata"));

    await expect(processStoryWorkflow("story", "run")).rejects.toThrow("PRIVACY_FAILED");
    expect(mocks.repository.saveRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "PRIVACY_FAILED", status: "failed" }));
    expect(mocks.repository.saveStory).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", activeRunId: undefined }), 1);
  });
});
