import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { currentDisclosureVersion } from "@/lib/consent";
import { MemoryStoryRepository } from "@/lib/web/memory-repository";
import { StoryService } from "@/lib/web/story-service";
import type { OwnerSession } from "@/lib/web/types";
import {
  HostedOwnerSessions,
  MemoryOwnerBindingStore,
  PostgresOwnerBindingStore,
  type OwnerBindingStore,
} from "@/app/api/mcp/_hosted/owner-sessions";

const owner = "owner-login",
  serverKey = "k".repeat(40);

function fixture(options: { bindings?: OwnerBindingStore; now?: () => Date } = {}) {
  const repository = new MemoryStoryRepository(),
    created: OwnerSession[] = [],
    recording = {
      createSession: async (session: OwnerSession) => {
        created.push(session);
        await repository.createSession(session);
      },
    },
    stories = new StoryService(repository, { start: async () => ({ workflowRunId: "workflow" }) }, options.now, value => `hash:${value}`),
    sessions = new HostedOwnerSessions({
      service: stories,
      repository: recording,
      bindings: options.bindings ?? new MemoryOwnerBindingStore(),
      key: serverKey,
      hashSecret: value => `hash:${value}`,
      now: options.now,
    });
  return { repository, created, stories, sessions };
}

/** A memory-backed stand-in for the two statements PostgresOwnerBindingStore sends. */
function bindingSql() {
  const rows = new Map<string, string>(),
    sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const statement = parts.join("?").replace(/\s+/g, " ").trim();
      if (statement.startsWith("SELECT owner_session_id FROM mcp_owner_bindings WHERE subject_hash = ?")) {
        const id = rows.get(String(values[0]));
        return id ? [{ owner_session_id: id }] : [];
      }
      if (statement.startsWith("INSERT INTO mcp_owner_bindings") && statement.includes("ON CONFLICT (subject_hash) DO NOTHING")) {
        if (!rows.has(String(values[0]))) rows.set(String(values[0]), String(values[1]));
        return [];
      }
      if (statement.startsWith("UPDATE mcp_owner_bindings") && statement.includes("AND owner_session_id = ?")) {
        const [sessionId, , subjectKey, expected] = values.map(String) as [string, string, string, string];
        if (rows.get(subjectKey) === expected) rows.set(subjectKey, sessionId);
        return [];
      }
      throw new Error(`unexpected statement: ${statement}`);
    };
  return { rows, sql: sql as unknown as NeonQueryFunction<false, false> };
}

// @verifies DES-WEB-MCP, ARCH-WEB-STORY, REQ-WEB-01, REQ-WEB-02
describe("hosted MCP owner session binding (BUI-2099)", () => {
  it("BUI-2099 R3: the first call creates one owner session with the current consent versions", async () => {
    const { created, stories, sessions } = fixture(),
      ownerSecret = await sessions.secretFor(owner);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ termsVersion: currentDisclosureVersion, uploadConsentVersion: currentDisclosureVersion });
    await expect(stories.requireSession(ownerSecret)).resolves.toMatchObject({ id: created[0]?.id });
  });

  it("BUI-2099 R3: every later call reuses the bound session", async () => {
    const { created, sessions } = fixture(),
      first = await sessions.secretFor(owner),
      again = await sessions.secretFor(owner),
      third = await sessions.secretFor(owner);
    expect(created).toHaveLength(1);
    expect(again).toBe(first);
    expect(third).toBe(first);
  });

  it("BUI-2099 R3: concurrent first calls end with one binding that both use", async () => {
    const { created, sessions } = fixture(),
      [left, right] = await Promise.all([sessions.secretFor(owner), sessions.secretFor(owner)]);
    expect(left).toBe(right);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(await sessions.secretFor(owner)).toBe(left);
  });

  it("BUI-2099 R3: binds a new session once retention has expired the bound one", async () => {
    let clock = new Date("2026-11-21T00:00:00Z");
    const { created, sessions } = fixture({ now: () => clock }),
      first = await sessions.secretFor(owner);
    clock = new Date("2027-01-01T00:00:00Z");
    const second = await sessions.secretFor(owner);
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
    expect(await sessions.secretFor(owner)).toBe(second);
  });

  it("BUI-2099 R3: binds a new session once the bound one is gone from the store", async () => {
    const bindings = new MemoryOwnerBindingStore(),
      first = fixture({ bindings }),
      original = await first.sessions.secretFor(owner),
      // A second repository without that session stands for one purged by retention.
      second = fixture({ bindings }),
      replacement = await second.sessions.secretFor(owner);
    expect(replacement).not.toBe(original);
    expect(second.created).toHaveLength(1);
  });

  it("BUI-2099 R3: the derived session secret differs per subject and never equals the server key", async () => {
    const { sessions } = fixture(),
      mine = await sessions.secretFor(owner),
      theirs = await sessions.secretFor("someone-else");
    expect(mine).not.toBe(theirs);
    expect(mine).not.toContain(serverKey);
  });

  it("BUI-2099 R3: refuses an empty subject and a short server key", async () => {
    const { sessions } = fixture();
    await expect(sessions.secretFor("")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(
      () =>
        new HostedOwnerSessions({
          service: fixture().stories,
          repository: new MemoryStoryRepository(),
          bindings: new MemoryOwnerBindingStore(),
          key: "short",
          hashSecret: value => value,
        })
    ).toThrow("WANDERPAGE_MCP_SESSION_KEY must be at least 32 characters.");
  });

  it("BUI-2099 R3: a store failure while checking the session propagates instead of binding a new session", async () => {
    const { repository, created, sessions } = fixture();
    await sessions.secretFor(owner);
    repository.renewSession = async () => {
      throw new Error("database unavailable");
    };
    await expect(sessions.secretFor(owner)).rejects.toThrow("database unavailable");
    expect(created).toHaveLength(1);
  });

  it("BUI-2099 R3: the Postgres binding store binds once and replaces only the expected session", async () => {
    const { rows, sql } = bindingSql(),
      store = new PostgresOwnerBindingStore(sql),
      now = new Date("2026-11-21T00:00:00Z");
    await expect(store.find("subject")).resolves.toBeUndefined();
    await expect(store.bind("subject", "session-a", undefined, now)).resolves.toBe("session-a");
    await expect(store.bind("subject", "session-b", undefined, now)).resolves.toBe("session-a");
    await expect(store.bind("subject", "session-c", "session-b", now)).resolves.toBe("session-a");
    await expect(store.bind("subject", "session-d", "session-a", now)).resolves.toBe("session-d");
    expect(rows.size).toBe(1);
  });

  it("BUI-2099 R3: owner sessions over the Postgres binding store reuse the bound session", async () => {
    const { sql } = bindingSql(),
      { created, sessions } = fixture({ bindings: new PostgresOwnerBindingStore(sql) }),
      first = await sessions.secretFor(owner);
    expect(await sessions.secretFor(owner)).toBe(first);
    expect(created).toHaveLength(1);
  });
});
