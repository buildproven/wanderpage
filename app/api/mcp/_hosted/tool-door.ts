// @design DES-WEB-MCP
// One stable door to every hosted tool (BUI-2220, REQ-MCP-9). Claude keeps a connector's tool list from the start of a chat, so a
// tool added in a later release is missing from an open chat. `recordTools` keeps each tool the server registers; `run_tool` with no
// arguments lists them all, and with a tool name checks the arguments against that tool's current schema on the server and returns the
// tool's own result. Its own schema never changes. It never runs itself or `delete_story`.
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type Handler = (args: Record<string, unknown>, extra: unknown) => unknown;

type ToolConfig = { title?: string; description?: string; inputSchema?: z.ZodType };

export type ToolEntry = { name: string; description: string; inputSchema: z.ZodType; handler: Handler };

export type ToolRegistry = Map<string, ToolEntry>;

/** Tools run_tool does not run: itself, and deletion, which the owner always calls directly. */
export const doorExcluded: ReadonlySet<string> = new Set(["run_tool", "delete_story"]);

/** Record every tool the server registers from now on; call before the first registerTool. */
export function recordTools(server: McpServer): ToolRegistry {
  const registry: ToolRegistry = new Map();
  const original = server.registerTool.bind(server) as (name: string, config: ToolConfig, handler: Handler) => unknown;
  const recording = (name: string, config: ToolConfig, handler: Handler): unknown => {
    registry.set(name, {
      name,
      description: config.description ?? "",
      inputSchema: config.inputSchema ?? z.strictObject({}),
      handler,
    });
    return original(name, config, handler);
  };
  Object.assign(server, { registerTool: recording });
  return registry;
}

export type CatalogEntry = { name: string; summary: string; arguments: string[] };

const firstSentence = (text: string) => (text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text).slice(0, 240);

/** Every tool with a one-line summary and its arguments (required ones end in `*`), sorted by name. */
export function toolCatalog(registry: ToolRegistry): CatalogEntry[] {
  return [...registry.values()]
    .map(entry => {
      const shape = entry.inputSchema instanceof z.ZodObject ? (entry.inputSchema.shape as Record<string, z.ZodType>) : {};
      return {
        name: entry.name,
        summary: firstSentence(entry.description),
        arguments: Object.entries(shape).map(([key, schema]) => (schema.safeParse(undefined).success ? key : `${key}*`)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const runToolInput = z.strictObject({
  tool: z.string().trim().min(1).max(64).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const refused = (text: string) => ({ isError: true as const, content: [{ type: "text" as const, text }] });

export function registerToolDoor(server: McpServer, registry: ToolRegistry) {
  server.registerTool(
    "run_tool",
    {
      title: "Run any Wanderpage tool",
      description:
        "List every Wanderpage tool the server has now (call with no arguments), or run one by name with its arguments. Claude keeps the tool list from the start of a chat, so call this first in a chat, and use it for a tool in its list that is missing from yours instead of asking the owner to start a new chat. The arguments are checked against the tool's current schema; the result is the tool's own. delete_story is not available here.",
      inputSchema: runToolInput,
    },
    async ({ tool, arguments: args }, extra): Promise<CallToolResult> => {
      if (tool === undefined) {
        const tools = toolCatalog(registry).filter(entry => entry.name !== "delete_story");
        return { content: [{ type: "text" as const, text: JSON.stringify({ tools }, null, 2) }], structuredContent: { tools } };
      }
      const entry = registry.get(tool);
      if (entry === undefined || doorExcluded.has(tool)) {
        const names = [...registry.keys()].filter(name => !doorExcluded.has(name)).sort();
        return refused(`No tool named "${tool}" can be run here; the tools are: ${names.join(", ")}.`);
      }
      const parsed = entry.inputSchema.safeParse(args ?? {});
      if (!parsed.success)
        return refused(parsed.error.issues.map(issue => `arguments.${issue.path.map(String).join(".")}: ${issue.message}`).join("; "));
      return (await entry.handler(parsed.data as Record<string, unknown>, extra)) as CallToolResult;
    }
  );
}
