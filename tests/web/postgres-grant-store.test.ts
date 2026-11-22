import { GrantStoreError } from "@buildproven/mcp-oauth";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { PostgresGrantStore } from "@/lib/web/grant-store";

/** A memory-backed stand-in for the statements PostgresGrantStore sends; the primary key on `id` is the Map key. */
function memorySql() {
  const rows = new Map<string, Date>(),
    statements: string[] = [],
    sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const statement = parts.join("?").replace(/\s+/g, " ").trim();
      statements.push(statement);
      if (statement === "DELETE FROM oauth_grants WHERE expires_at <= ?") {
        const now = values[0] as Date;
        for (const [id, expiresAt] of rows) if (expiresAt <= now) rows.delete(id);
        return [];
      }
      if (statement === "INSERT INTO oauth_grants (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id") {
        const [id, expiresAt] = values as [string, Date];
        if (rows.has(id)) return [];
        rows.set(id, expiresAt);
        return [{ id }];
      }
      if (statement === "SELECT id FROM oauth_grants WHERE id = ? AND expires_at > ?") {
        const [id, now] = values as [string, Date];
        const expiresAt = rows.get(id);
        return expiresAt && expiresAt > now ? [{ id }] : [];
      }
      throw new Error(`unexpected statement: ${statement}`);
    };
  return { rows, statements, sql: sql as unknown as NeonQueryFunction<false, false> };
}

const start = Date.parse("2026-11-21T00:00:00Z") / 1000;

// @verifies DES-WEB-STORE, ARCH-WEB-STORE
describe("Postgres OAuth grant store (BUI-2099)", () => {
  it("BUI-2099 R2: a second claim of the same id returns false", async () => {
    const { sql } = memorySql(),
      store = new PostgresGrantStore(
        () => sql,
        () => start * 1000
      );
    await expect(store.claim("code-1", start + 600)).resolves.toBe(true);
    await expect(store.claim("code-1", start + 600)).resolves.toBe(false);
    await expect(store.claim("code-2", start + 600)).resolves.toBe(true);
  });

  it("BUI-2099 R2: concurrent claims of one id succeed once", async () => {
    const { sql } = memorySql(),
      store = new PostgresGrantStore(
        () => sql,
        () => start * 1000
      ),
      results = await Promise.all([store.claim("refresh-1", start + 60), store.claim("refresh-1", start + 60)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("BUI-2099 R2: has reports a claimed id until it expires, and an expired id can be claimed again", async () => {
    let clock = start * 1000;
    const { rows, sql } = memorySql(),
      store = new PostgresGrantStore(
        () => sql,
        () => clock
      );
    await expect(store.has("family-1")).resolves.toBe(false);
    await store.claim("family-1", start + 60);
    await expect(store.has("family-1")).resolves.toBe(true);
    clock = (start + 61) * 1000;
    await expect(store.has("family-1")).resolves.toBe(false);
    await expect(store.claim("family-1", start + 120)).resolves.toBe(true);
    expect(rows.get("family-1")).toEqual(new Date((start + 120) * 1000));
  });

  it("BUI-2099 R2: stores the expiry given in seconds since the epoch", async () => {
    const { rows, sql } = memorySql(),
      store = new PostgresGrantStore(
        () => sql,
        () => start * 1000
      );
    await store.claim("code-1", start + 300);
    expect(rows.get("code-1")?.toISOString()).toBe("2026-11-21T00:05:00.000Z");
    await expect(store.claim("code-2", Number.NaN)).rejects.toBeInstanceOf(GrantStoreError);
  });

  it("BUI-2099 R2: a database failure rejects with a GrantStoreError, so no token is issued", async () => {
    const failing = (async () => {
        throw new Error("connection refused");
      }) as unknown as NeonQueryFunction<false, false>,
      store = new PostgresGrantStore(() => failing);
    const claim = store.claim("code-1", start + 60);
    await expect(claim).rejects.toBeInstanceOf(GrantStoreError);
    await expect(claim).rejects.toThrow("Wanderpage could not write the OAuth grant record: connection refused");
    await expect(store.has("code-1")).rejects.toBeInstanceOf(GrantStoreError);
  });

  it("BUI-2099 R2: without DATABASE_URL every call rejects with an owner-action GrantStoreError naming it", async () => {
    const store = PostgresGrantStore.fromEnvironment({});
    const error = await store.claim("code-1", start + 60).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GrantStoreError);
    expect(error).toMatchObject({ ownerAction: true, message: expect.stringContaining("DATABASE_URL") });
    await expect(store.has("code-1")).rejects.toBeInstanceOf(GrantStoreError);
  });
});
