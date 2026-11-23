import { readFileSync } from "node:fs";
import path from "node:path";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import type { Story, StoryRun } from "@/lib/web/types";

const repositoryFile = path.join(process.cwd(), "lib/web/neon-repository.ts");

/**
 * Lists every place where an interpolated parameter goes into an array function
 * (`cardinality(`, `ANY(`, `array_length(`) without an explicit `::<type>[]` cast.
 * Postgres cannot resolve a polymorphic function from an untyped (`unknown`) parameter.
 */
function uncastArrayParameters(source: string) {
  const pattern = /\b(cardinality|any|array_length)\s*\(\s*\$\{([^}]*)\}(?!\s*::\s*[a-z_][a-z0-9_]*\[\])/gi,
    findings: { line: number; text: string }[] = [];
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    findings.push({ line, text: match[0] });
  }
  return findings;
}

function recordingSql(rows: unknown[]) {
  const calls: { parts: string[]; values: unknown[] }[] = [];
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ parts: [...parts], values });
    return rows;
  }) as unknown as NeonQueryFunction<false, false>;
  return { sql, calls };
}

function onlyCall(calls: { parts: string[]; values: unknown[] }[]) {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (!call) throw new Error("expected one SQL call");
  return call;
}

// @verifies DES-WEB-STORE, ARCH-WEB-STORE
describe("Neon SQL array parameter casts (BUI-2168, REQ-WEB-04)", () => {
  it("REQ-WEB-04: completeRun casts every sourceUploadIds parameter to uuid[]", async () => {
    const { sql, calls } = recordingSql([{ id: "run-id" }]),
      repository = new NeonStoryRepository(sql),
      sourceUploadIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      story = { id: "story-id", version: 3, manifest: undefined } as unknown as Story,
      run = { id: "run-id", storyId: "story-id", sourceUploadIds } as unknown as StoryRun;
    await expect(repository.completeRun(story, run, undefined, new Date("2026-11-23T00:00:00Z"))).resolves.toBeUndefined();
    const call = onlyCall(calls);
    const positions = call.values.flatMap((value, index) => (value === sourceUploadIds ? [index] : []));
    expect(positions.length).toBeGreaterThanOrEqual(3);
    for (const index of positions) expect(call.parts[index + 1]).toMatch(/^::uuid\[\]/);
  });

  it("REQ-WEB-04: completeRun still reports a conflict when no run row is updated", async () => {
    const { sql } = recordingSql([]),
      repository = new NeonStoryRepository(sql),
      story = { id: "story-id", version: 3 } as unknown as Story,
      run = { id: "run-id", storyId: "story-id", sourceUploadIds: ["11111111-1111-4111-8111-111111111111"] } as unknown as StoryRun;
    await expect(repository.completeRun(story, run, undefined, new Date())).rejects.toThrow("RUN_STATE_CONFLICT");
  });

  it("REQ-WEB-04: listUploadsByIds casts its id list to uuid[]", async () => {
    const { sql, calls } = recordingSql([]),
      repository = new NeonStoryRepository(sql),
      ids = ["11111111-1111-4111-8111-111111111111"];
    await expect(repository.listUploadsByIds(ids)).resolves.toEqual([]);
    const call = onlyCall(calls),
      index = call.values.indexOf(ids);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(call.parts[index + 1]).toMatch(/^::uuid\[\]/);
  });

  it("REQ-WEB-04: every array function parameter in neon-repository.ts has an explicit ::<type>[] cast", () => {
    const findings = uncastArrayParameters(readFileSync(repositoryFile, "utf8"));
    expect(findings.map(finding => `lib/web/neon-repository.ts:${finding.line}: ${finding.text}`)).toEqual([]);
  });

  it("REQ-WEB-04: the scan flags uncast parameters and names the line", () => {
    const sample = [
      "const a = sql`SELECT 1`;",
      "const b = sql`WHERE n = cardinality(${ids})`;",
      "const c = sql`WHERE id = ANY(${ids})`;",
      "const d = sql`WHERE array_length(${ids}, 1) > 0`;",
      "const e = sql`WHERE id = ANY(${ids}::uuid[]) AND cardinality( ${ids} ::text[]) = 1`;",
      "const f = sql`WHERE id = any (${ids})`;",
    ].join("\n");
    expect(uncastArrayParameters(sample)).toEqual([
      { line: 2, text: "cardinality(${ids}" },
      { line: 3, text: "ANY(${ids}" },
      { line: 4, text: "array_length(${ids}" },
      { line: 6, text: "any (${ids}" },
    ]);
  });
});
