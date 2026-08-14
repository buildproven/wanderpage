import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { NeonStoryRepository } from "@/lib/web/neon-repository";

describe("Neon story repository", () => {
  it("maps PostgreSQL bigint upload sizes returned as decimal strings", async () => {
    const row = {
        id: "upload-id",
        story_id: "story-id",
        blob_path: "sources/story-id/upload-id",
        original_name: "photo.jpg",
        declared_type: "image/jpeg",
        byte_size: "1024",
        status: "confirmed",
        created_at: new Date("2026-08-14T00:00:00Z"),
      },
      sql = (async () => [row]) as unknown as NeonQueryFunction<false, false>,
      repository = new NeonStoryRepository(sql);
    await expect(repository.findUpload("upload-id")).resolves.toMatchObject({ byteSize: 1024 });
  });

  it("excludes doomed stories when deciding whether an owner session is orphaned", async () => {
    let statement = "";
    const sql = (async (parts: TemplateStringsArray) => {
        statement = parts.join("?");
        return [{ count: 1 }];
      }) as unknown as NeonQueryFunction<false, false>,
      repository = new NeonStoryRepository(sql);
    await expect(repository.purgeDeletedStories(new Date("2026-08-14T00:00:00Z"), 10)).resolves.toBe(1);
    expect(statement).toContain("s.id NOT IN (SELECT id FROM doomed)");
  });
});
