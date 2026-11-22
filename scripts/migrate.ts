// @design DES-WEB-MIGRATE
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "@neondatabase/serverless";

export type MigrationStatement = {
  text: string;
  values?: readonly unknown[];
};

export interface MigrationDatabase {
  query(statement: MigrationStatement): Promise<readonly Record<string, unknown>[]>;
  transaction(statements: readonly MigrationStatement[]): Promise<void>;
  close?(): Promise<void>;
}

type MigrationEnvironment = {
  VERCEL_ENV?: string;
  DATABASE_URL_UNPOOLED?: string;
  DATABASE_URL?: string;
};

type MigrationRuntime = {
  env?: MigrationEnvironment;
  migrationsDirectory?: string;
  connect?: (databaseUrl: string) => MigrationDatabase;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type MigrationFile = {
  name: string;
  order: bigint;
  sql: string;
};

const migrationName = /^(\d+).*\.sql$/;

// A migration file holds several statements. Neon's HTTP mode documents one statement per query, so the runner uses a
// WebSocket session (node-postgres semantics): a query without parameters may hold many statements, and BEGIN/COMMIT
// wrap the file and its ledger row. Node 24 provides the global WebSocket the driver needs.
function connectToNeon(databaseUrl: string): MigrationDatabase {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const run = async (client: Pick<PoolClient, "query">, statement: MigrationStatement) =>
    statement.values?.length ? (await client.query(statement.text, [...statement.values])).rows : (await client.query(statement.text)).rows;
  return {
    async query(statement) {
      return run(pool, statement);
    },
    async transaction(statements) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of statements) await run(client, statement);
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        throw cause;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function messageFrom(error: unknown, databaseUrl: string): string {
  return redact(describe(error), databaseUrl);
}

// A WebSocket failure reaches us as an ErrorEvent (not an Error); its cause sits in .error or .message.
function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "object" && error !== null) {
    const { error: inner, message } = error as { error?: unknown; message?: unknown };
    if (inner instanceof Error) return `WebSocket connection failed: ${inner.message || inner.name}`;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}

function redact(message: string, databaseUrl: string): string {
  return message.replaceAll(databaseUrl, "[redacted]").replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted]");
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true }),
    sqlFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith(".sql")),
    invalid = sqlFiles.find(entry => !migrationName.test(entry.name));
  if (invalid) throw new Error(`Migration file must start with a numeric prefix: ${invalid.name}`);
  const migrations = await Promise.all(
    sqlFiles.map(async entry => ({
      name: entry.name,
      order: BigInt(migrationName.exec(entry.name)![1]!),
      sql: await readFile(resolve(directory, entry.name), "utf8"),
    }))
  );
  return migrations.sort((left, right) =>
    left.order === right.order ? left.name.localeCompare(right.name) : left.order < right.order ? -1 : 1
  );
}

export async function runMigrations(runtime: MigrationRuntime = {}): Promise<number> {
  const env = runtime.env ?? process.env,
    log = runtime.log ?? console.log,
    errorLog = runtime.error ?? console.error,
    vercelEnvironment = env.VERCEL_ENV;
  if (vercelEnvironment !== "production") {
    log(`Skipping database migrations: VERCEL_ENV is ${vercelEnvironment ?? "unset"}, not production.`);
    return 0;
  }

  const databaseUrl = env.DATABASE_URL_UNPOOLED?.trim() || env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    errorLog("Database migration check failed: DATABASE_URL_UNPOOLED or DATABASE_URL is required in production.");
    return 1;
  }

  let database: MigrationDatabase | undefined;
  try {
    const migrations = await loadMigrations(runtime.migrationsDirectory ?? resolve(process.cwd(), "db/migrations"));
    database = (runtime.connect ?? connectToNeon)(databaseUrl);
    await database.query({
      text: `CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    });
    const rows = await database.query({ text: "SELECT name FROM schema_migrations ORDER BY name" }),
      recorded = new Set(
        rows.map(row => {
          if (typeof row.name !== "string") throw new Error("schema_migrations contains a non-text name");
          return row.name;
        })
      ),
      pending = migrations.filter(migration => !recorded.has(migration.name));

    if (!pending.length) {
      log("Database schema is current; no migrations to apply.");
      return 0;
    }

    for (const migration of pending) {
      try {
        await database.transaction([
          { text: migration.sql },
          {
            text: "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, CURRENT_TIMESTAMP)",
            values: [migration.name],
          },
        ]);
        log(`Applied database migration ${migration.name}.`);
      } catch (cause) {
        errorLog(`Database migration ${migration.name} failed: ${messageFrom(cause, databaseUrl)}`);
        return 1;
      }
    }
    log(`Applied ${pending.length} database migration${pending.length === 1 ? "" : "s"}.`);
    return 0;
  } catch (cause) {
    errorLog(`Database migration check failed: ${messageFrom(cause, databaseUrl)}`);
    return 1;
  } finally {
    await database?.close?.();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runMigrations();
}
