// @design DES-WEB-MCP
// Hosted MCP tools: the signed-in owner's hosted stories, read (BUI-2099) and changed (BUI-2100) through StoryService with the owner's
// bound session, so every business rule stays in StoryService. The stdio entry (mcp/server.ts) serves the local tools and is unchanged.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { cleanupStoryObjects } from "@/lib/web/object-cleanup";
import { StoryServiceError, type StoryService } from "@/lib/web/story-service";
import { LocationPrivacyModes, PeopleModes, type Story } from "@/lib/web/types";
import { currentDisclosureVersion } from "@/lib/consent";
import type { HostedOwnerSessions } from "@/app/api/mcp/_hosted/owner-sessions";

export type HostedServerOptions = {
  stories: Pick<
    StoryService,
    "listOwnedStories" | "getOwnedStory" | "createStory" | "queueGeneration" | "updateStory" | "publish" | "unpublish" | "prepareDelete"
  >;
  sessions: Pick<HostedOwnerSessions, "secretFor" | "secretForCreation" | "admissionKeyFor">;
  /** The access token's subject (`sub`). */
  subject: string | undefined;
  /** `WANDERPAGE_OWNER_SUBJECT`: the one subject the server serves. */
  ownerSubject: string;
  /** This deployment's origin (`https://host`), the base of a published story's public URL. Without it, `publicUrl` is null. */
  origin?: string;
  /** Removes a story's uploads and derivatives once its deletion has started. Default: the web delete route's Blob cleanup. */
  cleanupStory?: (storyId: string) => Promise<void>;
};

const storyId = z.uuid().describe("Story id, as returned by list_stories or create_story");
const title = z.string().trim().min(1).max(120).describe("Story title, 1 to 120 characters");
const listInput = z.strictObject({});
const getInput = z.strictObject({ storyId });
const createInput = z.strictObject({
  title,
  peopleMode: z.enum(PeopleModes).describe("include: photos may show people; exclude: leave out photos that show people"),
  locationPrivacy: z
    .enum(LocationPrivacyModes)
    .describe("broad: region-level places; approximate: city-level places; hidden: no places at all. Exact GPS is never published."),
});
const titleInput = z.strictObject({
  storyId,
  version: z.number().int().nonnegative().describe("The story version you last read (get_story); a newer version is a conflict"),
  title,
});

const defaultCleanup = (id: string) => cleanupStoryObjects(NeonStoryRepository.fromEnvironment(), id);

/** What the tools report for one story: never the manifest, the owner session or the admission key. */
export function storySummary(story: Story) {
  const published = story.status === "published";
  return {
    id: story.id,
    version: story.version,
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
async function answered(task: () => Promise<Record<string, unknown> | ToolError>) {
  try {
    const value = await task();
    return value instanceof ToolError ? value.result() : reply(value);
  } catch (error) {
    if (!(error instanceof StoryServiceError)) throw error;
    return new ToolError(error.message).result();
  }
}

/** A refusal that carries data the owner needs to recover, such as the current version after a conflict. */
class ToolError {
  constructor(
    readonly message: string,
    readonly data?: Record<string, unknown>
  ) {}

  result() {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: this.message }],
      ...(this.data ? { structuredContent: this.data } : {}),
    };
  }
}

export function createHostedServer({
  stories,
  sessions,
  subject,
  ownerSubject,
  origin,
  cleanupStory = defaultCleanup,
}: HostedServerOptions) {
  const server = new McpServer({ name: "wanderpage-hosted", version: "1.0.0" });
  // Serverless instances share no event bus and the tool list is fixed, so no change events are advertised.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  const ownerIdentity = () => {
    if (!ownerSubject || subject !== ownerSubject)
      throw new StoryServiceError("FORBIDDEN", "This Wanderpage serves only its owner. Sign in with the owner account.");
    return subject;
  };
  const ownerSecret = () => sessions.secretFor(ownerIdentity());
  const ownerSecretForCreation = () => sessions.secretForCreation(ownerIdentity());
  const ownerAdmissionKey = () => sessions.admissionKeyFor(subject ?? "");
  const withUrl = (story: Story) => {
    const summary = storySummary(story);
    return { ...summary, publicUrl: origin && summary.publicPath ? `${origin}${summary.publicPath}` : null };
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
  server.registerTool(
    "create_story",
    {
      title: "Create a hosted story",
      description:
        "Create a private hosted story with a title, a people choice and a location privacy level, under the current upload terms. " +
        "Returns the new story's id and version; add photos, then call start_generation.",
      inputSchema: createInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    input =>
      answered(async () => {
        const secret = await ownerSecretForCreation();
        return storySummary(
          await stories.createStory(
            secret,
            { ...input, termsVersion: currentDisclosureVersion, uploadConsentVersion: currentDisclosureVersion },
            ownerAdmissionKey()
          )
        );
      })
  );
  server.registerTool(
    "start_generation",
    {
      title: "Generate a hosted story",
      description: "Queue one generation run for a story whose photos are uploaded and confirmed. Returns the story in its queued state.",
      inputSchema: getInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ storyId }) =>
      answered(async () => {
        const secret = await ownerSecret();
        return storySummary(await stories.queueGeneration(secret, storyId, ownerAdmissionKey()));
      })
  );
  server.registerTool(
    "set_title",
    {
      title: "Rename a hosted story",
      description:
        "Change the title of a story that is uploading or a private draft. Pass the version you last read; if the story changed since, " +
        "the tool reports the conflict and the current version.",
      inputSchema: titleInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ storyId, version, title }) =>
      answered(async () => {
        const secret = await ownerSecret(),
          story = await stories.getOwnedStory(secret, storyId);
        try {
          const changes = { title, peopleMode: story.peopleMode, locationPrivacy: story.locationPrivacy };
          return storySummary(await stories.updateStory(secret, storyId, version, changes));
        } catch (error) {
          if (!(error instanceof StoryServiceError) || error.code !== "STORY_VERSION_CONFLICT") throw error;
          const currentVersion = (await stories.getOwnedStory(secret, storyId)).version;
          return new ToolError(
            `This story changed since version ${version}: its current version is ${currentVersion}. ` +
              "Read it with get_story and retry with that version.",
            { conflict: true, storyId, requestedVersion: version, currentVersion }
          );
        }
      })
  );
  server.registerTool(
    "publish",
    {
      title: "Publish a hosted story",
      description: "Publish one finished private draft after its final privacy check. Returns its public URL. Only this story changes.",
      inputSchema: getInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ storyId }) => answered(async () => withUrl(await stories.publish(await ownerSecret(), storyId)))
  );
  server.registerTool(
    "unpublish",
    {
      title: "Unpublish a hosted story",
      description: "Take one published story off its public URL; it becomes a private draft again. Only this story changes.",
      inputSchema: getInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ storyId }) => answered(async () => withUrl(await stories.unpublish(await ownerSecret(), storyId)))
  );
  server.registerTool(
    "delete_story",
    {
      title: "Delete a hosted story",
      description:
        "Start deleting one of your hosted stories: it leaves your list and its public URL at once, and its photos and pages are removed.",
      inputSchema: getInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ storyId }) =>
      answered(async () => {
        const deletion = await stories.prepareDelete(await ownerSecret(), storyId);
        if (!deletion.alreadyDeleted) await cleanupStory(storyId);
        return { id: storyId, deletion: deletion.alreadyDeleted ? "already deleted" : "started", status: deletion.story.status };
      })
  );
  return server;
}
