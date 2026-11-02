import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createDraft, draftWithReasons } from "../lib/automation/draft-tools";
import { drafts, inspectPhotos, workspace } from "../lib/automation/local";
import type { RunDependencies } from "../lib/pipeline/run";

export type ServerOptions = { root: string; dependencies?: Omit<RunDependencies, "root"> };

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

/** Builds the server; the photos stay on this machine and drafts live under `root`. */
export function createServer({ root, dependencies }: ServerOptions) {
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
