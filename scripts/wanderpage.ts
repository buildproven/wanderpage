#!/usr/bin/env node
// @design DES-CLI-AGENT
import { Command } from "commander";
import {
  drafts,
  error,
  exitCode,
  inspectPhotos,
  publishDraft,
  readDraft,
  result,
  validateDraft,
  workspace,
  type Operation,
} from "@/lib/automation/local";

const program = new Command()
  .name("wanderpage")
  .description("Create and review private local Wanderpage drafts.")
  .option("--workspace <path>")
  .option("--json");
program
  .command("inspect <photo-folder>")
  .description("Inspect a photo folder without provider calls or writes.")
  .action(async input => run("inspect", async () => result("inspect", await inspectPhotos(input), { changed: false })));
program
  .command("draft:list")
  .description("List local drafts.")
  .action(async () => run("list", async root => result("list", { drafts: await drafts(root) }, { changed: false })));
program
  .command("draft:show <slug>")
  .description("Show one local draft.")
  .action(async slug => run("show", async root => result("show", { slug, manifest: await readDraft(root, slug) }, { changed: false })));
program
  .command("draft:validate <slug>")
  .description("Validate a private draft without changing it.")
  .action(async slug =>
    run("validate", async root => {
      const data = await validateDraft(root, slug);
      return result(
        "validate",
        { slug, validatedFiles: data.validatedFiles },
        { changed: false, manifestDigest: data.manifestDigest, assetTreeDigest: data.assetTreeDigest }
      );
    })
  );
program
  .command("draft:publish <slug>")
  .description("Validate and publish a private draft.")
  .action(async slug => mutate("publish", slug, true));
program
  .command("draft:unpublish <slug>")
  .description("Validate and unpublish a local draft.")
  .action(async slug => mutate("unpublish", slug, false));
await program.parseAsync();

async function mutate(operation: "publish" | "unpublish", slug: string, published: boolean) {
  await run(operation, async root => {
    const data = await publishDraft(root, slug, published);
    return result(
      operation,
      { slug, published: data.manifest.published },
      { changed: true, manifestDigest: data.manifestDigest, assetTreeDigest: data.assetTreeDigest }
    );
  });
}

async function run(operation: Operation, action: (root: string) => Promise<ReturnType<typeof result>>) {
  try {
    const output = await action(await workspace(program.opts<{ workspace?: string }>().workspace));
    write(output);
  } catch (cause) {
    write(error(operation, cause));
    process.exitCode = exitCode(cause);
  }
}

function write(value: unknown) {
  if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if ("ok" in (value as object) && (value as { ok: boolean }).ok) process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stderr.write(`${JSON.stringify(value)}\n`);
}
