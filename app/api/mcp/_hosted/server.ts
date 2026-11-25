// @design DES-WEB-MCP
// Hosted MCP tools: the signed-in owner's hosted stories through StoryService with the owner's bound session. BUI-2099 reads them;
// BUI-2100 creates, generates, titles, publishes and deletes them with StoryService's own rules; BUI-2095 returns a one-time link to a
// story's private upload page; BUI-2146 returns a one-time link to a page that downloads a finished story as a ZIP. The stdio entry
// (mcp/server.ts) serves the local tools and is unchanged. BUI-2204 adds the `ui://` MCP App that `upload_photos` names: an in-chat
// photo picker that posts to the same link, which stays in the result as the browser fallback. BUI-2215 serves every signed-in subject
// when `WANDERPAGE_SIGNUP=open`, each with its own owner session, and turns the story and generation limits into refusals that name the
// limit and when it resets. BUI-2205 lets the owner's own Claude do the curation: `get_photos` pages through small WebP previews of the
// uploads, and `save_curation` stores Claude's chosen photos, captions and text as the draft, with no AI call on the server.
import type { SignupMode } from "@buildproven/mcp-oauth";
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
import { recordTools, registerToolDoor } from "@/app/api/mcp/_hosted/tool-door";
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
    | "listCurationPhotos"
    | "saveCuration"
  >;
  sessions: Pick<HostedOwnerSessions, "secretFor" | "admissionKeyFor">;
  /** The access token's subject (`sub`). */
  subject: string | undefined;
  /** `WANDERPAGE_OWNER_SUBJECT`: the one subject the server serves in owner mode. */
  ownerSubject: string;
  /** `WANDERPAGE_SIGNUP`: `owner` (default) serves only `ownerSubject`; `open` serves every subject, each with its own owner session. */
  signup?: SignupMode;
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
const photosInput = z.strictObject({
  storyId,
  cursor: z
    .union([z.string().regex(/^\d{1,4}$/), z.number().int().nonnegative().max(9999)])
    .nullable()
    .optional()
    .describe("The nextCursor of the previous get_photos page; leave it out (or send null) for the first page"),
});
const curationInput = z.strictObject({
  storyId,
  title: z.string().trim().min(1).max(120).describe("The page title, 1 to 120 characters"),
  intro: z.string().trim().min(1).max(2000).describe("The opening text of the page, 1 to 2000 characters"),
  closing: z.string().trim().max(1000).optional().describe("Optional closing line of the page, up to 1000 characters"),
  namesNoPerson: z
    .boolean()
    .optional()
    .describe(
      "Required, and must be true: your statement that no title, intro, closing or caption names or identifies a person. The call is " +
        "refused without it"
    ),
  photos: z
    .array(
      z.strictObject({
        photoId: z.string().min(1).max(100).describe("A photoId from get_photos"),
        caption: z.string().trim().min(1).max(300).describe("What the photo shows: scenes and places, never who a person is"),
        containsPeople: z
          .boolean()
          .optional()
          .describe(
            "Whether a person is visible. Required for every photo when the story excludes people; send false only after you checked"
          ),
      })
    )
    .min(1)
    .max(60)
    .describe("The chosen photos in page order; the first one is the hero photo"),
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

/** The per-session limits StoryService applies (`lib/web/story-service.ts`), in a rolling window of `limitWindowHours`. */
const sessionStoryLimit = 3;
const sessionGenerationLimit = 3;
const limitWindowHours = 24;
const limitWindowMs = limitWindowHours * 60 * 60 * 1000;
// StoryService reports every admission limit as INVALID_STATE with these messages, and gives no other sign of which limit it was.
const storyLimitMessage = /creation limit has been reached/,
  generationLimitMessage = /generation limit has been reached/;

const isLimit = (error: unknown, message: RegExp) =>
  error instanceof StoryServiceError && error.code === "INVALID_STATE" && message.test(error.message);

/**
 * The refusal for a reached story-creation limit. The reset is exact when every counted story is still listed (the oldest one stops
 * counting `limitWindowHours` after it was created); a deleted story still counts, so otherwise only the rolling rule is named.
 */
function storyLimitRefusal(listed: Story[], now: Date) {
  const counted = listed
      .map(story => story.createdAt.getTime())
      .filter(created => created + limitWindowMs > now.getTime())
      .sort((a, b) => a - b),
    oldest = counted.length >= sessionStoryLimit ? counted[0] : undefined,
    resetsAt = oldest === undefined ? undefined : new Date(oldest + limitWindowMs).toISOString();
  return new ToolRefusal(
    `create_story refused: each account can create ${sessionStoryLimit} new stories in any ${limitWindowHours} hours, and this one has ` +
      `reached that limit. A story stops counting ${limitWindowHours} hours after it was created` +
      (resetsAt ? `, so the next story can be created at ${resetsAt}.` : "; try again then."),
    { limit: "stories", maximum: sessionStoryLimit, windowHours: limitWindowHours, ...(resetsAt ? { resetsAt } : {}) }
  );
}

function generationLimitRefusal() {
  return new ToolRefusal(
    `start_generation refused: each account can start ${sessionGenerationLimit} generation runs in any ${limitWindowHours} hours, and ` +
      `Wanderpage also has a daily limit for all accounts together; a limit has been reached. A run stops counting ${limitWindowHours} ` +
      "hours after it started; try again then.",
    { limit: "generations", maximum: sessionGenerationLimit, windowHours: limitWindowHours }
  );
}

/** StoryService refusals become tool errors the owner can read; any other failure propagates to the MCP SDK. */
async function answered(task: () => Promise<Record<string, unknown>>) {
  try {
    return reply(await task());
  } catch (error) {
    return refusal(error);
  }
}

/** The tool error for a StoryService refusal or a ToolRefusal; any other failure is rethrown to the MCP SDK. */
function refusal(error: unknown) {
  if (!(error instanceof StoryServiceError) && !(error instanceof ToolRefusal)) throw error;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: error.message }],
    ...(error instanceof ToolRefusal && error.detail ? { structuredContent: error.detail } : {}),
  };
}

const removeWithNeon = (storyId: string) => cleanupStoryObjects(NeonStoryRepository.fromEnvironment(), storyId);

export function createHostedServer({
  stories,
  sessions,
  subject,
  ownerSubject,
  signup = "owner",
  publicOrigin,
  removeObjects = removeWithNeon,
  uploadLinks,
  downloadLinks,
}: HostedServerOptions) {
  const server = new McpServer(
    { name: "wanderpage-hosted", version: "1.0.0" },
    {
      instructions:
        "Start each chat with run_tool and no arguments: it lists every Wanderpage tool the server has now. A tool in that list but not in your tool list was added after this chat started: call it through run_tool with its name and arguments, never by asking the owner to start a new chat.",
    }
  );
  // BUI-2220: record every tool so run_tool can list and reach it.
  const registry = recordTools(server);
  // Serverless instances share no event bus and the tool list is fixed, so no change events are advertised.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  /** The caller's subject. Open mode serves every signed-in subject; owner mode serves only the owner. */
  const caller = () => {
    if (signup === "open") {
      if (!subject) throw new StoryServiceError("AUTH_REQUIRED", "The access token names no account. Sign in again.");
      return subject;
    }
    if (!ownerSubject || subject !== ownerSubject)
      throw new StoryServiceError("FORBIDDEN", "This Wanderpage serves only its owner. Sign in with the owner account.");
    return subject;
  };
  // Every signed-in subject gets an `owner`-kind session: the kind marks a signed-in MCP account, held to per-account limits, apart from
  // the anonymous web creator's `public` session. The operator's controls for signed-in accounts other than the owner are
  // `WANDERPAGE_SIGNUP` (read on every request; unset, it refuses them at the token check and leaves the owner working) and
  // `WANDERPAGE_OWNER_GENERATION_ENABLED=false` (refuses every signed-in account's writes). `WANDERPAGE_GENERATION_ENABLED` stays the
  // anonymous creator's switch, so opening signup never needs it on and never reopens anonymous creation.
  const ownerSecret = () => sessions.secretFor(caller());
  // Each subject has its own admission key, so one account's creation and generation limits never count another's.
  const admissionKey = () => sessions.admissionKeyFor(caller());
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
        "Returns the new story's id; then call upload_photos and open its link to add photos before get_photos and save_curation.",
      inputSchema: createInput,
    },
    input =>
      answered(async () => {
        const secret = await ownerSecret();
        try {
          const story = await stories.createStory(
            secret,
            { ...input, termsVersion: currentDisclosureVersion, uploadConsentVersion: currentDisclosureVersion },
            admissionKey()
          );
          return storySummary(story);
        } catch (error) {
          if (!isLimit(error, storyLimitMessage)) throw error;
          throw storyLimitRefusal(await stories.listOwnedStories(secret), new Date());
        }
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
        try {
          return storySummary(await stories.queueGeneration(secret, storyId, admissionKey()));
        } catch (error) {
          if (isLimit(error, generationLimitMessage)) throw generationLimitRefusal();
          throw error;
        }
      })
  );
  server.registerTool(
    "get_photos",
    {
      title: "Review a hosted story's photos",
      description:
        "Return one page of a story's uploaded photos as small WebP previews, each with its photoId, capture date and a place no finer " +
        "than city level (none in a hidden story; never exact GPS), plus nextCursor. Call again with nextCursor until it is null, look " +
        "at every photo, then choose and order the photos, write the captions and text yourself, and call save_curation. Works while " +
        "the story is uploading or failed, before its photos expire.",
      inputSchema: photosInput,
      annotations: { readOnlyHint: true },
    },
    async ({ storyId, cursor }) => {
      let page: Awaited<ReturnType<HostedServerOptions["stories"]["listCurationPhotos"]>>;
      try {
        page = await stories.listCurationPhotos(await ownerSecret(), storyId, cursor === undefined || cursor === null ? 0 : Number(cursor));
      } catch (error) {
        return refusal(error);
      }
      const summary = {
        storyId: page.story.id,
        peopleMode: page.story.peopleMode,
        locationPrivacy: page.story.locationPrivacy,
        total: page.total,
        photos: page.photos.map(({ photoId, captureDate, place }) => ({ photoId, captureDate, place })),
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
      };
      // Each preview follows a line naming its photoId, so the model can match what it sees to the IDs save_curation takes.
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          ...page.photos.flatMap(photo => [
            { type: "text" as const, text: `photoId ${photo.photoId}:` },
            { type: "image" as const, data: photo.thumbnail.toString("base64"), mimeType: "image/webp" },
          ]),
        ],
        structuredContent: summary,
      };
    }
  );
  server.registerTool(
    "save_curation",
    {
      title: "Save Claude's curation as the draft",
      description:
        "Save the trip page you curated from get_photos as the story's private draft: the chosen photoIds in page order, a caption " +
        "for each, a title and intro text (and an optional closing line), and namesNoPerson: true. Never name or identify a person; " +
        "the call is refused without namesNoPerson: true. When the story excludes people, send containsPeople for every photo and " +
        "leave out each photo that shows a person. The server only resizes the chosen photos and builds the page; it does not count " +
        "toward the generation limit. Then show the owner the draft and offer download_page or publish.",
      inputSchema: curationInput,
    },
    ({ storyId, ...curation }) =>
      answered(async () => storySummary(await stories.saveCuration(await ownerSecret(), storyId, curation, admissionKey())))
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
        "upload, call get_photos to review them and save_curation to save the page you write.",
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
  registerToolDoor(server, registry);
  return server;
}

function versionConflict(storyId: string, sentVersion: number, currentVersion: number) {
  return new ToolRefusal(
    `This story changed since version ${sentVersion}: the current version is ${currentVersion}. Read it with get_story and try again.`,
    { conflict: true, storyId, sentVersion, currentVersion }
  );
}
