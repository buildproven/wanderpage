import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations, type MigrationDatabase, type MigrationStatement } from "@/scripts/migrate";

type MemoryState = {
  migrations: Map<string, Date>;
  tables: Set<string>;
};

function memoryDatabase() {
  const state: MemoryState = { migrations: new Map(), tables: new Set() },
    transactions: string[][] = [];

  const execute = (target: MemoryState, statement: MigrationStatement) => {
    const normalized = statement.text.replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(normalized)) {
      target.tables.add("schema_migrations");
      return [];
    }
    if (/^SELECT name FROM schema_migrations/i.test(normalized)) {
      return [...target.migrations].map(([name, applied_at]) => ({ name, applied_at }));
    }
    if (/^INSERT INTO schema_migrations/i.test(normalized)) {
      const name = statement.values?.[0];
      if (typeof name !== "string") throw new Error("migration name was not bound");
      target.migrations.set(name, new Date("2026-11-22T12:00:00Z"));
      return [];
    }
    for (const command of statement.text
      .split(";")
      .map(part => part.trim())
      .filter(Boolean)) {
      if (command === "RAISE_FAILURE") {
        throw new Error(`synthetic database failure at ${"postgres" + "://db.example.invalid/wanderpage"}`);
      }
      const create = /^CREATE TABLE ([a-z_]+)$/i.exec(command);
      if (!create) throw new Error(`unexpected SQL: ${command}`);
      target.tables.add(create[1]!);
    }
    return [];
  };

  const database: MigrationDatabase = {
    async query(statement) {
      return execute(state, statement);
    },
    async transaction(statements) {
      const pending: MemoryState = {
        migrations: new Map(state.migrations),
        tables: new Set(state.tables),
      };
      for (const statement of statements) execute(pending, statement);
      state.migrations = pending.migrations;
      state.tables = pending.tables;
      transactions.push(statements.map(statement => statement.text));
    },
  };
  return { database, state, transactions };
}

async function migrationDirectory(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "wanderpage-migrations-"));
  temporaryDirectories.push(directory);
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(directory, name), sql)));
  return directory;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true })));
});

// @verifies DES-WEB-MIGRATE
describe("production database migrations (BUI-2123)", () => {
  it("BUI-2123 R1: wires the migration runner before the Vercel build", async () => {
    const packageManifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      },
      vercelConfiguration = JSON.parse(await readFile(join(process.cwd(), "vercel.json"), "utf8")) as {
        buildCommand?: string;
      };
    expect(packageManifest.scripts?.migrate).toBe("tsx scripts/migrate.ts");
    expect(vercelConfiguration.buildCommand).toBe("pnpm migrate && pnpm build");
  });

  it("BUI-2123 R1-R2: applies pending files numerically, records them, then reports the schema current", async () => {
    const directory = await migrationDirectory({
        "0010_ten.sql": "CREATE TABLE ten",
        "0002_two.sql": "CREATE TABLE two",
        "0001_one.sql": "CREATE TABLE one",
      }),
      { database, state, transactions } = memoryDatabase(),
      logs: string[] = [],
      selectedUrls: string[] = [],
      pooledUrl = "postgres" + "://pooled.example.invalid/wanderpage",
      unpooledUrl = "postgres" + "://db.example.invalid/wanderpage",
      runtime = {
        env: { VERCEL_ENV: "production", DATABASE_URL: pooledUrl, DATABASE_URL_UNPOOLED: unpooledUrl },
        migrationsDirectory: directory,
        connect: (url: string) => {
          selectedUrls.push(url);
          return database;
        },
        log: (message: string) => logs.push(message),
        error: (message: string) => logs.push(message),
      };

    await expect(runMigrations(runtime)).resolves.toBe(0);
    expect([...state.migrations.keys()]).toEqual(["0001_one.sql", "0002_two.sql", "0010_ten.sql"]);
    expect([...state.migrations.values()][0]).toBeInstanceOf(Date);
    expect(transactions).toHaveLength(3);
    expect(selectedUrls).toEqual([unpooledUrl]);

    await expect(runMigrations(runtime)).resolves.toBe(0);
    expect(transactions).toHaveLength(3);
    expect(logs).toContain("Database schema is current; no migrations to apply.");
  });

  it("BUI-2123 R3: rolls back a failing file, names its error without the connection string, and returns non-zero", async () => {
    const directory = await migrationDirectory({
        "0001_good.sql": "CREATE TABLE good",
        "0002_broken.sql": "CREATE TABLE partial; RAISE_FAILURE",
        "0003_later.sql": "CREATE TABLE later",
      }),
      { database, state } = memoryDatabase(),
      errors: string[] = [],
      databaseUrl = "postgres" + "://db.example.invalid/wanderpage";

    await expect(
      runMigrations({
        env: { VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: databaseUrl },
        migrationsDirectory: directory,
        connect: () => database,
        log: () => undefined,
        error: (message: string) => errors.push(message),
      })
    ).resolves.toBe(1);

    expect([...state.migrations.keys()]).toEqual(["0001_good.sql"]);
    expect(state.tables).toContain("good");
    expect(state.tables).not.toContain("partial");
    expect(state.tables).not.toContain("later");
    expect(errors.join("\n")).toContain("0002_broken.sql");
    expect(errors.join("\n")).toContain("synthetic database failure");
    expect(errors.join("\n")).not.toContain(databaseUrl);
  });

  it.each([undefined, "preview", "development"])("BUI-2123 R4: skips without connecting when VERCEL_ENV is %s", async vercelEnvironment => {
    const logs: string[] = [];
    let connected = false;
    await expect(
      runMigrations({
        env: { VERCEL_ENV: vercelEnvironment, DATABASE_URL: "postgres" + "://preview.invalid/wanderpage" },
        connect: () => {
          connected = true;
          return memoryDatabase().database;
        },
        log: (message: string) => logs.push(message),
        error: (message: string) => logs.push(message),
      })
    ).resolves.toBe(0);
    expect(connected).toBe(false);
    expect(logs.join("\n")).toContain("not production");
  });

  it("BUI-2123 R1: falls back to DATABASE_URL and fails safely when production has no database setting", async () => {
    const directory = await migrationDirectory({}),
      { database } = memoryDatabase(),
      pooledUrl = "postgres" + "://pooled.example.invalid/wanderpage",
      selectedUrls: string[] = [],
      errors: string[] = [];
    await expect(
      runMigrations({
        env: { VERCEL_ENV: "production", DATABASE_URL: pooledUrl },
        migrationsDirectory: directory,
        connect: url => {
          selectedUrls.push(url);
          return database;
        },
        log: () => undefined,
        error: message => errors.push(message),
      })
    ).resolves.toBe(0);
    expect(selectedUrls).toEqual([pooledUrl]);

    await expect(
      runMigrations({
        env: { VERCEL_ENV: "production" },
        migrationsDirectory: directory,
        connect: () => database,
        log: () => undefined,
        error: message => errors.push(message),
      })
    ).resolves.toBe(1);
    expect(errors.at(-1)).toContain("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
  });

  it("BUI-2123 R1: rejects a SQL migration without a numeric prefix instead of silently skipping it", async () => {
    const directory = await migrationDirectory({ "bootstrap.sql": "CREATE TABLE bootstrap" }),
      errors: string[] = [];
    await expect(
      runMigrations({
        env: { VERCEL_ENV: "production", DATABASE_URL: "postgres" + "://db.example.invalid/wanderpage" },
        migrationsDirectory: directory,
        connect: () => memoryDatabase().database,
        log: () => undefined,
        error: message => errors.push(message),
      })
    ).resolves.toBe(1);
    expect(errors.join("\n")).toContain("bootstrap.sql");
    expect(errors.join("\n")).toContain("numeric prefix");
  });
});

describe("BUI-2123 connection failures", () => {
  it("BUI-2123 R3: names a WebSocket ErrorEvent's cause, redacts the URL, and closes the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wanderpage-migrate-event-")),
      databaseUrl = "postgres" + "://user:secret@db.example.invalid/wanderpage",
      errors: string[] = [];
    let closed = false;
    try {
      await writeFile(join(directory, "0001_a.sql"), "CREATE TABLE a");
      const failing: MigrationDatabase = {
        // The Neon WebSocket driver rejects with an ErrorEvent, which is not an Error.
        query: () => Promise.reject({ type: "error", error: new Error(`connect ECONNREFUSED via ${databaseUrl}`) }),
        transaction: () => Promise.resolve(),
        close: async () => {
          closed = true;
        },
      };
      await expect(
        runMigrations({
          env: { VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: databaseUrl },
          migrationsDirectory: directory,
          connect: () => failing,
          log: () => undefined,
          error: (message: string) => errors.push(message),
        })
      ).resolves.toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(errors.join("\n")).toContain("WebSocket connection failed: connect ECONNREFUSED");
    expect(errors.join("\n")).not.toContain("[object");
    expect(errors.join("\n")).not.toContain("secret");
    expect(closed).toBe(true);
  });
});
