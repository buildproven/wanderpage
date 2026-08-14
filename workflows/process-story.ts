import { FatalError } from "workflow";
import { del } from "@vercel/blob";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { processStory, validateHostedStoryOutput } from "@/lib/web/processor";
import { cleanupRunDerivatives } from "@/lib/web/object-cleanup";

export async function processStoryWorkflow(storyId: string, runId: string) {
  "use workflow";
  const state = await claimProcessing(storyId, runId);
  if (state === "complete") {
    await deleteOriginalUploads(storyId, runId);
    return;
  }
  try {
    const result = await runCurationPipeline(storyId, runId);
    await validatePrivacy(storyId, runId, result.manifest);
    await completeProcessing(storyId, runId, result.manifest);
  } catch (error) {
    await recordFailure(storyId, runId, error);
    let cleanupError: unknown;
    try {
      await deleteFailedDerivatives(storyId, runId);
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) throw new AggregateError([error, cleanupError], "Story processing and derivative cleanup both failed.");
    throw error;
  }
  await deleteOriginalUploads(storyId, runId);
}

async function deleteFailedDerivatives(storyId: string, runId: string) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    run = await repository.findRun(runId);
  if (run && run.storyId === storyId && (run.status === "failed" || run.status === "cancelled"))
    await cleanupRunDerivatives(repository, run);
}

async function deleteOriginalUploads(storyId: string, runId: string) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || run.status !== "complete") return;
  const uploads = await repository.listUploadsByIds(run.sourceUploadIds);
  await Promise.all(uploads.map(upload => del(upload.blobPath)));
  const now = new Date();
  await Promise.all(uploads.map(upload => repository.saveUpload({ ...upload, status: "deleted", deletedAt: now })));
}

async function claimProcessing(storyId: string, runId: string) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    now = new Date(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if ((story?.status === "draft" || story?.status === "published") && !story.activeRunId && run?.status === "complete")
    return "complete" as const;
  try {
    await repository.claimRun(storyId, runId, now);
    return "processing" as const;
  } catch {
    throw new FatalError("Story run is no longer eligible for processing.");
  }
}

async function runCurationPipeline(storyId: string, runId: string) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || story.activeRunId !== runId || story.status !== "processing")
    throw new FatalError("Story run is no longer eligible for processing.");
  await repository.markRunProgress(storyId, runId, "curating", 12, new Date());
  return processStory(story, await repository.listUploadsByIds(run.sourceUploadIds));
}

async function completeProcessing(storyId: string, runId: string, manifest: Awaited<ReturnType<typeof processStory>>["manifest"]) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (story?.status === "draft" && !story.activeRunId && run?.status === "complete") return;
  if (!story || !run || story.activeRunId !== runId || story.status !== "processing")
    throw new FatalError("Story run is no longer eligible for completion.");
  const now = new Date();
  await repository.completeRun(story, run, manifest, now);
}

async function validatePrivacy(storyId: string, runId: string, manifest: Awaited<ReturnType<typeof processStory>>["manifest"]) {
  "use step";
  try {
    const repository = NeonStoryRepository.fromEnvironment(),
      story = await repository.findStory(storyId),
      run = await repository.findRun(runId);
    if (!story || !run || story.activeRunId !== runId || story.status !== "processing")
      throw new Error("Story run is no longer eligible for privacy validation.");
    await validateHostedStoryOutput(storyId, runId, manifest, story.locationPrivacy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Hosted output failed privacy validation.";
    throw new FatalError(detail.startsWith("PRIVACY_FAILED:") ? detail : `PRIVACY_FAILED: ${detail}`);
  }
}

async function recordFailure(storyId: string, runId: string, error: unknown) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || story.activeRunId !== runId) return;
  const now = new Date();
  const detail = error instanceof Error ? error.message : String(error),
    privacyFailed = detail.includes("PRIVACY_FAILED");
  await repository.saveRun({
    ...run,
    status: "failed",
    stage: "failed",
    errorCode: privacyFailed ? "PRIVACY_FAILED" : "PROCESSING_FAILED",
    errorMessage: privacyFailed
      ? "Wanderpage blocked this draft because its hosted output failed privacy validation. Your original photos remain private."
      : "Wanderpage could not finish this draft. Your original photos remain private.",
    finishedAt: now,
    updatedAt: now,
  });
  await repository.saveStory({ ...story, status: "failed", activeRunId: undefined, updatedAt: now }, story.version);
}
