import { afterEach, describe, expect, it } from "vitest";
import { loadHostedPublishedStory } from "@/lib/web/published-story";

describe("hosted published story loading", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("fails closed when hosted storage is not configured", async () => {
    delete process.env.DATABASE_URL;
    await expect(loadHostedPublishedStory("bundled-local-trip")).rejects.toThrow("DATABASE_URL is required");
  });

  it("rejects invalid slugs without touching storage", async () => {
    delete process.env.DATABASE_URL;
    await expect(loadHostedPublishedStory("../private")).resolves.toBeUndefined();
  });
});
