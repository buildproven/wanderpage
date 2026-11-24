// @design DES-WEB-MCP
// Hosted MCP tools: the signed-in owner's hosted stories through StoryService with the owner's bound session. BUI-2099 reads them;
// BUI-2100 creates, generates, titles, publishes and deletes them with StoryService's own rules; BUI-2095 returns a one-time link to a
// story's private upload page; BUI-2146 returns a one-time link to a page that downloads a finished story as a ZIP. The stdio entry
// (mcp/server.ts) serves the local tools and is unchanged. BUI-2204 adds the `ui://` MCP App that `upload_photos` names: an in-chat
// photo picker that posts to the same link, which stays in the result as the browser fallback.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { currentDisclosureVersion } from "@/lib/consent";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import { cleanupStoryObjects } from "@/lib/web/object-cleanup";
import { StoryServiceError, type StoryService } from "@/lib/web/story-service";
import { LocationPrivacyModes, PeopleModes, type Story } from "@/lib/web/types";
import type { DownloadLinks } from "@/lib/web/download-link";
import type { UploadLinks } from "@/lib/web/upload-link";
import type { HostedOwnerSessions } from "@/app/api/mcp/_hosted/owner-sessions";
import { uploadPickerHtml, uploadPickerMeta, uploadPickerMimeType, uploadPickerUri } from "@/app/api/mcp/_hosted/upload-page";

export type HostedServerOptions = {
  stories: Pick<
    StoryService,
    | "listOwnedStories"
    | "getOwnedStory"
    | "createStory"
    | "queueGeneration"
    | "updateStory"
    | "publish"
    | "unpublish"
    | "prepareDelete"
    | "confirmedPhotoCount"
  >;
  sessions: Pick<HostedOwnerSessions, "secretFor" | "admissionKeyFor">;
  /** The access token's subject (`sub`). */
  subject: string | undefined;
  /** `WANDERPAGE_OWNER_SUBJECT`: the one subject the server serves. */
  ownerSubject: string;
  /** The deployment origin the request reached (`https://host`), so `publish` can return the full public URL. */
  publicOrigin?: string;
  /** Removes a deleted story's source uploads and derivatives, as the web DELETE route does. Default: Vercel Blob via Neon. */
  removeObjects?: (storyId: string) => Promise<void>;
  /** Issues one-time upload links (`upload_photos`): Neon `upload_links` under the session pepper's upload-link key in production. */
  uploadLinks?: Pick<UploadLinks, "issue">;
  /** Issues one-time download links (`download_page`): Neon `download_links` under the session pepper's download-link key in production. */
  downloadLinks?: Pick<DownloadLinks, "issue">;
};

const storyId = z.uuid().describe("Story id, as returned by list_stories or create_story");
const listInput = z.strictObject({});
const getInput = z.strictObject({ storyId });
const createInput = z.strictObject({
  title: z.string().trim().min(1).max(120).describe("Story title, 1 to 120 characters"),
  peopleMode: z.enum(PeopleModes).describe("include: photos may show people; exclude: leave photos with people out"),
  locationPrivacy: z.enum(LocationPrivacyModes).describe("broad: region names; approximate: city-level places; hidden: no places"),
});
const titleInput = z.strictObject({
  storyId,
  title: z.string().trim().min(1).max(120).describe("New story title, 1 to 120 characters"),
  version: z.number().int().nonnegative().describe("The story version this edit is based on, as returned by get_story"),
});

/**
 * What the tools report for one story: never the manifest, the owner session or the admission key. `photoCount` is the confirmed uploads
 * while the story is uploading (`confirmedPhotos`), and the curated photos once it has a manifest.
 */
export function storySummary(story: Story, confirmedPhotos = 0) {
  const published = story.status === "published";
  return {
    id: story.id,
    title: story.title,
    status: story.status,
    photoCount: story.status === "uploading" ? confirmedPhotos : (story.manifest?.photos.length ?? 0),
    published,
    publicPath: published && story.publicSlug ? `/s/${story.publicSlug}` : null,
    publishedAt: published && story.publishedAt ? story.publishedAt.toISOString() : null,
    updatedAt: story.updatedAt.toISOString(),
    version: story.version,
  };
}

const reply = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

/** A tool error the owner can read, with optional machine-readable detail. */
class ToolRefusal extends Error {
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** StoryService refusals become tool errors the owner can read; any other failure propagates to the MCP SDK. */
async function answered(task: () => Promise<Record<string, unknown>>) {
  try {
    return reply(await task());
  } catch (error) {
    if (!(error instanceof StoryServiceError) && !(error instanceof ToolRefusal)) throw error;
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: error.message }],
      ...(error instanceof ToolRefusal && error.detail ? { structuredContent: error.detail } : {}),
    };
  }
}

const removeWithNeon = (storyId: string) => cleanupStoryObjects(NeonStoryRepository.fromEnvironment(), storyId);

export function createHostedServer({
  stories,
  sessions,
  subject,
  ownerSubject,
  publicOrigin,
  removeObjects = removeWithNeon,
  uploadLinks,
  downloadLinks,
}: HostedServerOptions) {
  const server = new McpServer({ name: "wanderpage-hosted", version: "1.0.0" });
  // Serverless instances share no event bus and the tool list is fixed, so no change events are advertised.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  const ownerSecret = () => {
    if (!ownerSubject || subject !== ownerSubject)
      throw new StoryServiceError("FORBIDDEN", "This Wanderpage serves only its owner. Sign in with the owner account.");
    return sessions.secretFor(subject);
  };
  // Called only after ownerSecret() has accepted the subject, so ownerSubject is the caller.
  const admissionKey = () => sessions.admissionKeyFor(ownerSubject);
  const summarize = async (story: Story) =>
    storySummary(story, story.status === "uploading" ? await stories.confirmedPhotoCount(story) : 0);
  /** The owner's story, or a refusal naming the tool when it belongs to another private session. */
  const ownedStory = async (secret: string, storyId: string, tool: string) => {
    try {
      return await stories.getOwnedStory(secret, storyId);
    } catch (error) {
      if (error instanceof StoryServiceError && error.code === "FORBIDDEN")
        throw new ToolRefusal(`${tool} refused: this story belongs to another private session.`);
      throw error;
    }
  };
  const published = (story: Story) => {
    const summary = storySummary(story);
    return { ...summary, publicUrl: summary.publicPath && publicOrigin ? `${publicOrigin}${summary.publicPath}` : null };
  };
  server.registerTool(
    "list_stories",
    {
      title: "List your hosted stories",
      description: "List your hosted Wanderpage stories, newest first, with each one's status, title, photo count and publish state.",
      inputSchema: listInput,
      annotations: { readOnlyHint: true },
    },
    () => answered(async () => ({ stories: await Promise.all((await stories.listOwnedStories(await ownerSecret())).map(summarize)) }))
  );
  server.registerTool(
    "get_story",
    {
      title: "Read one hosted story",
      description: "Return one of your hosted stories: its status, title, photo count and publish state.",
      inputSchema: getInput,
      annotations: { readOnlyHint: true },
    },
    ({ storyId }) => answered(async () => summarize(await stories.getOwnedStory(await ownerSecret(), storyId)))
  );
  server.registerTool(
    "create_story",
    {
      title: "Create a hosted story",
      description:
        "Create a private hosted story with a title, a people choice and a location privacy choice, under the current upload terms. " +
        "Returns the new story's id; then call upload_photos and open its link to add photos before start_generation.",
      inputSchema: createInput,
    },
    input =>
      answered(async () => {
        const secret = await ownerSecret(),
          story = await stories.createStory(
            secret,
            { ...input, termsVersion: currentDisclosureVersion, uploadConsentVersion: currentDisclosureVersion },
            admissionKey()
          );
        return storySummary(story);
      })
  );
  server.registerTool(
    "start_generation",
    {
      title: "Generate a hosted story",
      description: "Queue one generation run for a story whose photo uploads are complete. Returns the queued story.",
      inputSchema: getInput,
    },
    ({ storyId }) =>
      answered(async () => {
        const secret = await ownerSecret();
        return storySummary(await stories.queueGeneration(secret, storyId, admissionKey()));
      })
  );
  server.registerTool(
    "set_title",
    {
      title: "Rename a hosted story",
      description:
        "Change the title of a story that is uploading or a private draft. Pass the version from get_story; a stale version is refused " +
        "with the current version.",
      inputSchema: titleInput,
    },
    ({ storyId, title, version }) =>
      answered(async () => {
        const secret = await ownerSecret(),
          story = await stories.getOwnedStory(secret, storyId);
        if (story.version !== version) throw versionConflict(storyId, version, story.version);
        try {
          return await summarize(
            await stories.updateStory(secret, storyId, version, {
              title,
              peopleMode: story.peopleMode,
              locationPrivacy: story.locationPrivacy,
            })
          );
        } catch (error) {
          if (!(error instanceof StoryServiceError) || error.code !== "STORY_VERSION_CONFLICT") throw error;
          throw versionConflict(storyId, version, (await stories.getOwnedStory(secret, storyId)).version);
        }
      })
  );
  server.registerResource(
    "upload_photos_picker",
    uploadPickerUri,
    {
      title: "Wanderpage photo picker",
      description: "The in-chat photo picker upload_photos shows: it uploads the picked photos to the story through its one-time link.",
      mimeType: uploadPickerMimeType,
    },
    uri => ({
      contents: [{ uri: uri.href, mimeType: uploadPickerMimeType, text: uploadPickerHtml(), _meta: uploadPickerMeta(publicOrigin) }],
    })
  );
  const pickerLink = { ui: { resourceUri: uploadPickerUri } };
  server.registerTool(
    "upload_photos",
    {
      title: "Upload photos to a hosted story",
      description:
        "Show an in-chat photo picker for this story and return a one-time link, valid for 15 minutes, that opens the story's private " +
        "page in your browser. Pick the photos (JPEG, PNG or WebP, 6 to 60) in the picker, or open the link when the picker does not " +
        "show or fails. Photos attached to the chat do not reach Wanderpage. Only a story that is still uploading takes photos. After the " +
        "upload, call start_generation.",
      inputSchema: getInput,
      _meta: pickerLink,
    },
    async ({ storyId }) => {
      const result = await answered(async () => {
        const secret = await ownerSecret(),
          story = await ownedStory(secret, storyId, "upload_photos");
        if (story.status !== "uploading")
          throw new ToolRefusal(
            `upload_photos refused: "${story.title}" is ${story.status}. Photos can be added only while a story is uploading, before ` +
              "start_generation. Create a new story with create_story to upload other photos.",
            { storyId: story.id, status: story.status }
          );
        if (!publicOrigin || !uploadLinks) throw new Error("upload_photos needs the deployment origin and an upload-link store.");
        const link = await uploadLinks.issue(story.id, secret);
        return { storyId: story.id, uploadUrl: `${publicOrigin}/upload/${link.token}`, expiresAt: link.expiresAt.toISOString() };
      });
      if ("isError" in result) return result;
      const { uploadUrl } = result.structuredContent as { uploadUrl: string };
      // The picker this call opens, with its link: a host that shows embedded resources needs no template read.
      const picker = {
        type: "resource" as const,
        resource: {
          uri: uploadPickerUri,
          mimeType: uploadPickerMimeType,
          text: uploadPickerHtml(uploadUrl),
          _meta: uploadPickerMeta(publicOrigin),
        },
      };
      return { ...result, content: [...result.content, picker], _meta: pickerLink };
    }
  );
  server.registerTool(
    "download_page",
    {
      title: "Download a hosted story as a ZIP",
      description:
        "Return a one-time link, valid for 15 minutes, that opens a page in your browser where one button downloads this story as a " +
        "ZIP: an index.html and its images, which open from the unzipped folder and can be hosted anywhere. A file attached to the chat " +
        "cannot come from this connector, so the file comes through the link. Only a finished draft or a published story can be downloaded.",
      inputSchema: getInput,
    },
    ({ storyId }) =>
      answered(async () => {
        const secret = await ownerSecret(),
          story = await ownedStory(secret, storyId, "download_page");
        if (story.status !== "draft" && story.status !== "published")
          throw new ToolRefusal(
            `download_page refused: "${story.title}" is ${story.status}. Only a finished draft or a published story can be downloaded. ` +
              "Wait for generation to finish, or create the story with create_story.",
            { storyId: story.id, status: story.status }
          );
        if (!publicOrigin || !downloadLinks) throw new Error("download_page needs the deployment origin and a download-link store.");
        const link = await downloadLinks.issue(story.id, secret);
        return { storyId: story.id, downloadUrl: `${publicOrigin}/download/${link.token}`, expiresAt: link.expiresAt.toISOString() };
      })
  );
  server.registerTool(
    "publish",
    {
      title: "Publish a hosted story",
      description: "Publish one finished private draft and return its public URL. A story that is not a finished draft is refused.",
      inputSchema: getInput,
    },
    ({ storyId }) => answered(async () => published(await stories.publish(await ownerSecret(), storyId)))
  );
  server.registerTool(
    "unpublish",
    {
      title: "Unpublish a hosted story",
      description: "Take one published story off its public URL; it stays a private draft.",
      inputSchema: getInput,
    },
    ({ storyId }) => answered(async () => published(await stories.unpublish(await ownerSecret(), storyId)))
  );
  server.registerTool(
    "delete_story",
    {
      title: "Delete a hosted story",
      description:
        "Delete one story: it leaves your list at once, its photos and generated files are removed, and the daily cleanup purges the record.",
      inputSchema: getInput,
      annotations: { destructiveHint: true },
    },
    ({ storyId }) =>
      answered(async () => {
        const deletion = await stories.prepareDelete(await ownerSecret(), storyId);
        if (!deletion.alreadyDeleted) await removeObjects(storyId);
        return { id: deletion.story.id, status: deletion.story.status, deleted: true };
      })
  );
  return server;
}

function versionConflict(storyId: string, sentVersion: number, currentVersion: number) {
  return new ToolRefusal(
    `This story changed since version ${sentVersion}: the current version is ${currentVersion}. Read it with get_story and try again.`,
    { conflict: true, storyId, sentVersion, currentVersion }
  );
}
