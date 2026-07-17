#!/usr/bin/env node
import { Command } from "commander";
import { listTrips, setTripPublished } from "@/lib/trips/publish";

const root = process.env.WANDERPAGE_WORKSPACE ?? process.cwd();

const program = new Command().name("trip-publish").description("Toggle whether a generated trip is included in the published static site");
program
  .command("list")
  .description("List generated trips and their publish state")
  .action(async () => {
    const trips = await listTrips(root);
    if (!trips.length) {
      console.log("No trips found in data/trips.");
      return;
    }
    for (const { slug, manifest } of trips)
      console.log(`${manifest.published ? "published  " : "unpublished"}  ${slug}  ${manifest.title}`);
  });
program
  .command("publish <slug>")
  .description("Include a trip in the next static build")
  .action(async (slug: string) => run(slug, true));
program
  .command("unpublish <slug>")
  .description("Exclude a trip from the next static build without deleting it")
  .action(async (slug: string) => run(slug, false));
await program.parseAsync();

async function run(slug: string, published: boolean) {
  try {
    await setTripPublished(root, slug, published);
    console.log(`${published ? "Published" : "Unpublished"} ${slug} — rebuild with pnpm build to apply.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
