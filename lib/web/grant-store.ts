// @design DES-WEB-STORE
import { GrantStoreError, type GrantStore } from "@buildproven/mcp-oauth";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

type Sql = NeonQueryFunction<false, false>;

/**
 * Spent OAuth authorization codes and refresh tokens, shared by every serverless instance (table `oauth_grants`, migration 0006).
 * The primary key on `id` makes `claim` true for the first claim only. A row past its `expiresAt` is pruned on the next claim, so the
 * ID may be claimed again, as the `GrantStore` contract allows. Every database failure rejects with a `GrantStoreError`, so the
 * authorization server answers 503 and issues no token.
 */
export class PostgresGrantStore implements GrantStore {
  constructor(
    private readonly connect: () => Sql,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Connects on first use, so a missing `DATABASE_URL` is a 503 naming the setting, not a crash at import. */
  static fromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env) {
    let sql: Sql | undefined;
    return new PostgresGrantStore(() => {
      if (sql) return sql;
      const url = env.DATABASE_URL?.trim();
      if (!url) throw new GrantStoreError("DATABASE_URL is required to record spent Wanderpage OAuth grants.", true);
      sql = neon(url);
      return sql;
    });
  }

  async claim(id: string, expiresAt: number) {
    const sql = this.connect(),
      now = new Date(this.now()),
      expires = new Date(expiresAt * 1000);
    if (Number.isNaN(expires.getTime())) throw new GrantStoreError("The OAuth grant expiry is not a valid time.");
    const rows = await recorded("write", async () => {
      await sql`DELETE FROM oauth_grants WHERE expires_at <= ${now}`;
      return sql`INSERT INTO oauth_grants (id, expires_at) VALUES (${id}, ${expires}) ON CONFLICT (id) DO NOTHING RETURNING id`;
    });
    return rows.length === 1;
  }

  async has(id: string) {
    const sql = this.connect(),
      now = new Date(this.now()),
      rows = await recorded("read", () => sql`SELECT id FROM oauth_grants WHERE id = ${id} AND expires_at > ${now}`);
    return rows.length > 0;
  }
}

async function recorded<T>(action: "read" | "write", task: () => Promise<T>) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof GrantStoreError) throw error;
    throw new GrantStoreError(
      `Wanderpage could not ${action} the OAuth grant record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
