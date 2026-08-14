import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverStaticOutput, replaceStaticOutput } from "@/lib/static-output";

describe("static rollback artifact replacement", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

  it("recovers the preserved artifact after interruption leaves out absent", async () => {
    const root = await workspace(),
      prior = join(root, ".out-prior-interrupted");
    await mkdir(prior);
    await writeFile(join(prior, "version.txt"), "prior");
    await recoverStaticOutput(root);
    await expect(readFile(join(root, "out/version.txt"), "utf8")).resolves.toBe("prior");
    expect((await readdir(root)).filter(name => name.startsWith(".out-"))).toEqual([]);
  });

  it("publishes a complete staged artifact and removes swap residue", async () => {
    const root = await workspace(),
      built = join(root, "built");
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out/version.txt"), "prior");
    await mkdir(built);
    await writeFile(join(built, "version.txt"), "next");
    await replaceStaticOutput(root, built);
    await expect(readFile(join(root, "out/version.txt"), "utf8")).resolves.toBe("next");
    expect((await readdir(root)).filter(name => name.startsWith(".out-"))).toEqual([]);
  });

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), "wanderpage-output-test-"));
    roots.push(root);
    return root;
  }
});
