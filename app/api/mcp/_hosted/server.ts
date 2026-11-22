// @design DES-WEB-MCP
// Hosted MCP tools (BUI-2099): the signed-in owner's hosted stories, read through StoryService with the owner's bound session. The stdio
// entry (mcp/server.ts) serves the local tools and is unchanged.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { StoryServiceError, type StoryService } from "@/lib/web/story-service";
import type { Story } from "@/lib/web/types";
import type { HostedOwnerSessions } from "@/app/api/mcp/_hosted/owner-sessions";

export type HostedServerOptions = {
  stories: Pick<StoryService, "listOwnedStories" | "getOwnedStory">;
  sessions: Pick<HostedOwnerSessions, "secretFor">;
  /** The access token's subject (`sub`). */
  subject: string | undefined;
  /** `WANDERPAGE_OWNER_SUBJECT`: the one subject the server serves. */
  ownerSubject: string;
};

const listInput = z.strictObject({});
const getInput = z.strictObject({ storyId: z.uuid().describe("Story id, as returned by list_stories") });

/** What the tools report for one story: never the manifest, the owner session or the admission key. */
export function storySummary(story: Story) {
  const published = story.status === "published";
  return {
    id: story.id,
    title: story.title,
    status: story.status,
    photoCount: story.manifest?.photos.length ?? 0,
    published,
    publicPath: published && story.publicSlug ? `/s/${story.publicSlug}` : null,
    publishedAt: published && story.publishedAt ? story.publishedAt.toISOString() : null,
    updatedAt: story.updatedAt.toISOString(),
  };
}

const reply = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

/** StoryService refusals become tool errors the owner can read; any other failure propagates to the MCP SDK. */
async function answered(task: () => Promise<Record<string, unknown>>) {
  try {
    return reply(await task());
  } catch (error) {
    if (!(error instanceof StoryServiceError)) throw error;
    return { isError: true as const, content: [{ type: "text" as const, text: error.message }] };
  }
}

export function createHostedServer({ stories, sessions, subject, ownerSubject }: HostedServerOptions) {
  const server = new McpServer({ name: "wanderpage-hosted", version: "1.0.0" });
  // Serverless instances share no event bus and the tool list is fixed, so no change events are advertised.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  const ownerSecret = () => {
    if (!ownerSubject || subject !== ownerSubject)
      throw new StoryServiceError("FORBIDDEN", "This Wanderpage serves only its owner. Sign in with the owner account.");
    return sessions.secretFor(subject);
  };
  server.registerTool(
    "list_stories",
    {
      title: "List your hosted stories",
      description: "List your hosted Wanderpage stories, newest first, with each one's status, title, photo count and publish state.",
      inputSchema: listInput,
      annotations: { readOnlyHint: true },
    },
    () => answered(async () => ({ stories: (await stories.listOwnedStories(await ownerSecret())).map(storySummary) }))
  );
  server.registerTool(
    "get_story",
    {
      title: "Read one hosted story",
      description: "Return one of your hosted stories: its status, title, photo count and publish state.",
      inputSchema: getInput,
      annotations: { readOnlyHint: true },
    },
    ({ storyId }) => answered(async () => storySummary(await stories.getOwnedStory(await ownerSecret(), storyId)))
  );
  return server;
}
