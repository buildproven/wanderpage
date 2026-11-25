// BUI-2220: run_tool, one stable door to every hosted tool, so a tool added after a chat started is still reachable.
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import { HostedOwnerSessions, MemoryOwnerBindingStore } from "@/app/api/mcp/_hosted/owner-sessions";
import { createHostedServer } from "@/app/api/mcp/_hosted/server";

const owner = "owner-login",
  origin = "https://trips.example.com",
  storyInput = {
    title: "Kyoto in autumn",
    peopleMode: "exclude" as const,
    locationPrivacy: "approximate" as const,
    termsVersion: currentDisclosureVersion,
    uploadConsentVersion: currentDisclosureVersion,
  };

async function fixture(subject = owner) {
  const repository = new MemoryStoryRepository(),
    policy = { enabled: true, dailyLimit: 25 },
    started: string[] = [],
    removed: string[] = [],
    stories = new StoryService(
      repository,
      {
        start: async (storyId: string) => {
          started.push(storyId);
          return { workflowRunId: `workflow-${started.length}` };
        },
      },
      undefined,
      value => `hash:${value}`,
      () => policy,
      async () => undefined
    ),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository,
      bindings: new MemoryOwnerBindingStore(),
      key: "k".repeat(40),
      hashSecret: value => `hash:${value}`,
    }),
    server = createHostedServer({
      stories,
      sessions,
      subject,
      ownerSubject: owner,
      publicOrigin: origin,
      removeObjects: async storyId => {
        removed.push(storyId);
      },
    }),
    client = new Client({ name: "hosted-door-test", version: "1.0.0" }),
    [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { repository, stories, sessions, client, policy, started, removed };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError === true,
    text: (response.content as Array<{ text?: string }>)[0]?.text ?? "",
    data: response.structuredContent as Record<string, unknown> | undefined,
  };
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-MCP-9
describe("BUI-2220 REQ-MCP-9: run_tool", () => {
  it("lists every hosted tool except delete_story, with its arguments, when called with no arguments", async () => {
    const { client } = await fixture(),
      result = await call(client, "run_tool", {}),
      tools = (result.data as { tools: Array<{ name: string; summary: string; arguments: string[] }> }).tools,
      listed = (await client.listTools()).tools
        .map(tool => tool.name)
        .filter(name => name !== "delete_story")
        .sort();
    expect(result.isError).toBe(false);
    expect(tools.map(tool => tool.name)).toEqual(listed);
    expect(tools.find(tool => tool.name === "get_story")?.arguments).toEqual(["storyId*"]);
    expect(tools.find(tool => tool.name === "run_tool")?.arguments).toEqual(["tool", "arguments"]);
    for (const tool of tools) expect(tool.summary.length).toBeGreaterThan(5);
  });

  it("runs a tool by name and returns exactly what the tool returns", async () => {
    const context = await fixture();
    await context.stories.createStory(await context.sessions.secretFor(owner), storyInput);
    const direct = await call(context.client, "list_stories", {}),
      through = await call(context.client, "run_tool", { tool: "list_stories", arguments: {} });
    expect(through).toEqual(direct);
  });

  it("checks the arguments against the tool's schema and names the field", async () => {
    const { client } = await fixture(),
      missing = await call(client, "run_tool", { tool: "get_story", arguments: {} }),
      extra = await call(client, "run_tool", { tool: "list_stories", arguments: { surprise: true } });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("arguments.storyId");
    expect(extra.isError).toBe(true);
  });

  it("refuses an unknown tool, itself and delete_story, and names the tools it can run", async () => {
    const { client } = await fixture();
    for (const tool of ["no_such_tool", "run_tool", "delete_story"]) {
      const result = await call(client, "run_tool", { tool });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("publish");
      expect(result.text).not.toMatch(/tools are:[^.]*delete_story/);
    }
  });

  it("publishes an open arguments object and tells the agent to call it first", async () => {
    const { client } = await fixture(),
      door = (await client.listTools()).tools.find(tool => tool.name === "run_tool"),
      args = (door?.inputSchema.properties as Record<string, { type?: string; additionalProperties?: unknown }>).arguments;
    expect(args?.type).toBe("object");
    expect(args?.additionalProperties).not.toBe(false);
    expect(client.getInstructions()).toMatch(/Start each chat with run_tool/);
  });
});
