import { FatalError } from "workflow";
import { del } from "@vercel/blob";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { processStory } from "@/lib/web/processor";

export async function processStoryWorkflow(storyId: string, runId: string) {
  "use workflow";
  try {
    await claimProcessing(storyId, runId);
    const result = await runCurationPipeline(storyId, runId);
    await completeProcessing(storyId, runId, result.manifest);
    await deleteOriginalUploads(storyId, runId);
  } catch (error) {
    await recordFailure(storyId, runId, error);
    throw error;
  }
}

async function deleteOriginalUploads(storyId: string, runId: string) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || run.status !== "complete") return;
  const uploads = (await repository.listUploads(story.id)).filter(upload => upload.status === "confirmed");
  await Promise.all(uploads.map(upload => del(upload.blobPath)));
  const now = new Date();
  await Promise.all(uploads.map(upload => repository.saveUpload({ ...upload, status: "deleted", deletedAt: now })));
}

async function claimProcessing(storyId: string, runId: string) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || story.activeRunId !== runId || story.status !== "queued")
    throw new FatalError("Story run is no longer eligible for processing.");
  await repository.saveStory({ ...story, status: "processing", updatedAt: new Date() }, story.version);
  await repository.saveRun({
    ...run,
    status: "processing",
    stage: "curating",
    progress: 5,
    attempts: run.attempts + 1,
    startedAt: new Date(),
    updatedAt: new Date(),
  });
}

async function runCurationPipeline(storyId: string, runId: string) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || story.activeRunId !== runId || story.status !== "processing")
    throw new FatalError("Story run is no longer eligible for processing.");
  await repository.saveRun({ ...run, stage: "curating", progress: 12, updatedAt: new Date() });
  return processStory(story, await repository.listUploads(story.id));
}

async function completeProcessing(storyId: string, runId: string, manifest: Awaited<ReturnType<typeof processStory>>["manifest"]) {
  "use step";
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || story.activeRunId !== runId || story.status !== "processing")
    throw new FatalError("Story run is no longer eligible for completion.");
  const now = new Date();
  await repository.completeRun(story, run, manifest, now);
}

async function recordFailure(storyId: string, runId: string, error: unknown) {
  "use step";
  void error;
  const repository = NeonStoryRepository.fromEnvironment(),
    story = await repository.findStory(storyId),
    run = await repository.findRun(runId);
  if (!story || !run || story.activeRunId !== runId) return;
  const now = new Date();
  await repository.saveRun({
    ...run,
    status: "failed",
    stage: "failed",
    errorCode: "PROCESSING_FAILED",
    errorMessage: "Wanderpage could not finish this draft. Your original photos remain private.",
    finishedAt: now,
    updatedAt: now,
  });
  await repository.saveStory({ ...story, status: "failed", activeRunId: undefined, updatedAt: now }, story.version);
}
