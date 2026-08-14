import { start } from "workflow/api";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { hashSecret, StoryService } from "@/lib/web/story-service";
import { processStoryWorkflow } from "@/workflows/process-story";

let service: StoryService | undefined;

export function getStoryService() {
  if (service) return service;
  const pepper = process.env.WANDERPAGE_SESSION_PEPPER;
  if (!pepper) throw new Error("WANDERPAGE_SESSION_PEPPER is required for web story sessions.");
  const repository = NeonStoryRepository.fromEnvironment();
  service = new StoryService(
    repository,
    {
      start: async (storyId, runId) => {
        const run = await start(processStoryWorkflow, [storyId, runId]);
        return { workflowRunId: run.runId };
      },
    },
    undefined,
    secret => hashSecret(secret, pepper)
  );
  return service;
}

export function clearStoryServiceForTests() {
  service = undefined;
}
