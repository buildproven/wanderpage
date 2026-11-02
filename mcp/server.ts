import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createDraft, draftWithReasons } from "../lib/automation/draft-tools";
import { drafts, inspectPhotos, workspace } from "../lib/automation/local";
import { editDraft, previewDraft, publishSite, type PublishOptions } from "../lib/automation/publish-tools";
import type { RunDependencies } from "../lib/pipeline/run";

export type ServerOptions = { root: string; dependencies?: Omit<RunDependencies, "root">; publishing?: PublishOptions };

const folder = z.string().min(1).describe("Absolute path of a folder of photos on this Mac");
const slug = z.string().min(1).describe("Draft slug, as returned by create_draft or list_drafts");

const inspectInput = z.strictObject({ folder });
const createInput = z.strictObject({
  folder,
  people: z.enum(["include", "exclude"]).describe("exclude drops every photo with visible people and needs OPENAI_API_KEY"),
  locationPrivacy: z.enum(["hidden", "broad", "approximate", "precise"]),
  title: z.string().min(1).max(200).optional(),
  maxPhotos: z.number().int().min(1).max(500).optional().describe("Upper bound; the selection never picks fewer than 18 photos"),
});
const getInput = z.strictObject({ slug });
const listInput = z.strictObject({});
const photoId = z.string().min(1).describe("Photo id from the draft manifest");
const editInput = z.strictObject({
  slug,
  removePhotoIds: z.array(photoId).min(1).max(500).optional().describe("Photos to drop from the story"),
  heroPhotoId: photoId.optional().describe("Photo to lead the story; it must stay in the draft"),
  title: z.string().trim().min(1).max(200).optional(),
  captions: z
    .array(z.strictObject({ photoId, caption: z.string().max(500).describe("New caption; an empty string removes it") }))
    .min(1)
    .max(500)
    .optional(),
});

const reply = (value: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});
const failure = (cause: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: cause instanceof Error ? cause.message : String(cause) }],
});
async function guarded(task: () => Promise<object>) {
  try {
    return reply(await task());
  } catch (cause) {
    return failure(cause);
  }
}

async function preview(root: string, name: string) {
  try {
    const { sheets, ...summary } = await previewDraft(root, name);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ...summary, sheets: sheets.length }, null, 2) },
        ...sheets.map(data => ({ type: "image" as const, data, mimeType: "image/jpeg" })),
      ],
    };
  } catch (cause) {
    return failure(cause);
  }
}

/** Builds the server; the photos stay on this machine and drafts live under `root`. */
export function createServer({ root, dependencies, publishing }: ServerOptions) {
  const server = new McpServer({ name: "wanderpage", version: "1.0.0" });
  server.registerTool(
    "inspect_photos",
    {
      title: "Inspect a photo folder",
      description: "Count the supported photos in a folder and report whether GPS data and capture dates were found. Writes nothing.",
      inputSchema: inspectInput,
      annotations: { readOnlyHint: true },
    },
    ({ folder: path }) => guarded(() => inspectPhotos(path))
  );
  server.registerTool(
    "create_draft",
    {
      title: "Create a private trip draft",
      description:
        "Edit a photo folder into a private (unpublished) trip draft. Returns the slug and a summary including the number of photos actually selected.",
      inputSchema: createInput,
    },
    input => guarded(() => createDraft(root, input, dependencies))
  );
  server.registerTool(
    "get_draft",
    {
      title: "Read a trip draft",
      description: "Return a draft's manifest and the reason each photo was selected.",
      inputSchema: getInput,
      annotations: { readOnlyHint: true },
    },
    ({ slug: name }) => guarded(() => draftWithReasons(root, name))
  );
  server.registerTool(
    "list_drafts",
    {
      title: "List trip drafts",
      description: "List every draft's slug and title with whether it is published.",
      inputSchema: listInput,
      annotations: { readOnlyHint: true },
    },
    () => guarded(async () => ({ drafts: await drafts(root) }))
  );
  server.registerTool(
    "edit_draft",
    {
      title: "Edit a trip draft",
      description:
        "Remove photos, set the hero photo, retitle, or change captions of an unpublished draft. Applies Studio's draft check and returns the updated manifest; an invalid change changes nothing.",
      inputSchema: editInput,
    },
    ({ slug: name, ...changes }) => guarded(() => editDraft(root, name, changes))
  );
  server.registerTool(
    "preview_draft",
    {
      title: "Preview a trip draft",
      description:
        "Return contact-sheet images (up to 16 photos each, in story order, labelled by photo id) built from the draft's published web images.",
      inputSchema: getInput,
      annotations: { readOnlyHint: true },
    },
    ({ slug: name }) => preview(root, name)
  );
  server.registerTool(
    "publish_site",
    {
      title: "Publish a trip and build the site",
      description:
        "Publish the draft, build the static site into out/, and run the privacy scan. Returns the out/ path and the scan result; when the scan finds anything it returns the findings as an error, deploys nothing, and puts the draft back.",
      inputSchema: getInput,
    },
    ({ slug: name }) => guarded(() => publishSite(root, name, publishing))
  );
  return server;
}

/** Serves MCP over stdio. Standard output carries the protocol, so pipeline logging goes to standard error. */
export async function main() {
  console.log = console.error;
  console.warn = console.error;
  const root = await workspace(process.env.WANDERPAGE_WORKSPACE);
  serveStdio(() => createServer({ root }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(cause => {
    console.error(cause);
    process.exitCode = 1;
  });
}
