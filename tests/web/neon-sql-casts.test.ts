import { readFileSync } from "node:fs";
import path from "node:path";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { NeonStoryRepository } from "@/lib/web/neon-repository";
import type { Story, StoryRun } from "@/lib/web/types";

const ARRAY_FUNCTION_PARAMETER = /\b(cardinality|ANY|array_length)\(\s*\$\{[^}]*\}(?!::[a-z_]+\[\])/gi;

function uncastArrayParameters(source: string) {
  return [...source.matchAll(ARRAY_FUNCTION_PARAMETER)].map(match => {
    const line = source.slice(0, match.index).split("\n").length;
    return `line ${line}: ${match[0]}`;
  });
}

function recordingSql(result: unknown[]) {
  const calls: { parts: readonly string[]; values: unknown[] }[] = [];
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ parts: [...parts], values });
    return result;
  }) as unknown as NeonQueryFunction<false, false>;
  return { sql, calls };
}

function castsAfter(call: { parts: readonly string[]; values: unknown[] }, value: unknown) {
  return call.values.flatMap((candidate, index) => (candidate === value ? [call.parts[index + 1] ?? ""] : []));
}

// @verifies DES-WEB-STORE, ARCH-WEB-STORE
describe("Neon SQL array parameter casts (BUI-2168)", () => {
  it("BUI-2168: completeRun casts every upload id parameter to uuid[]", async () => {
    const { sql, calls } = recordingSql([{ id: "run-id" }]);
    const repository = new NeonStoryRepository(sql);
    const sourceUploadIds = ["7f0c7a4e-1d2b-4c5e-9f00-000000000001", "7f0c7a4e-1d2b-4c5e-9f00-000000000002"];
    const now = new Date("2026-11-23T00:00:00Z");
    await repository.completeRun({ id: "story-id", version: 3 } as Story, { id: "run-id", sourceUploadIds } as StoryRun, undefined, now);
    expect(calls).toHaveLength(1);
    const casts = castsAfter(calls[0]!, sourceUploadIds);
    expect(casts).toHaveLength(3);
    for (const following of casts) expect(following.startsWith("::uuid[]")).toBe(true);
  });

  it("BUI-2168: listUploadsByIds casts its id list to uuid[]", async () => {
    const { sql, calls } = recordingSql([]);
    const repository = new NeonStoryRepository(sql);
    const ids = ["7f0c7a4e-1d2b-4c5e-9f00-000000000003"];
    await repository.listUploadsByIds(ids);
    const casts = castsAfter(calls[0]!, ids);
    expect(casts).toHaveLength(1);
    expect(casts[0]!.startsWith("::uuid[]")).toBe(true);
  });

  it("BUI-2168: no SQL template passes an uncast parameter to cardinality, ANY or array_length", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/web/neon-repository.ts"), "utf8");
    expect(uncastArrayParameters(source)).toEqual([]);
  });

  it("BUI-2168: the scan names the line of an uncast array parameter", () => {
    const sample = ["SELECT 1", "WHERE n = cardinality(${ids})", "AND id = ANY(${ids}::uuid[])", "AND array_length(${ids}, 1) > 0"].join(
      "\n"
    );
    expect(uncastArrayParameters(sample)).toEqual(["line 2: cardinality(${ids}", "line 4: array_length(${ids}"]);
    expect(uncastArrayParameters("cardinality(${run.sourceUploadIds}::uuid[])")).toEqual([]);
  });
});
