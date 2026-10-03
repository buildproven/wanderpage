#!/usr/bin/env node
// @design DES-CLI-TRIP
import { Command } from "commander";
import { runTrip } from "@/lib/pipeline/run";

const program = new Command()
  .name("trip")
  .description("Turn a local vacation photo folder into a private static story")
  .option("--input <path>", "Folder containing vacation photos")
  .option("--people <mode>", "Whether photos containing people may be published")
  .option("--title <text>", "Story title")
  .option("--max-photos <number>", "Maximum selected photos", "36")
  .option("--privacy <mode>", "Location privacy: hidden, broad, approximate (~11 km), or precise (~1 km)", "approximate")
  .option("--force", "Ignore cached analysis", false)
  .option("--dry-run", "Analyze and report without updating the site", false)
  .option("--demo", "Generate the deterministic demo", false)
  .option("--deploy", "Deploy the completed static export", false);
program.parse();
const options = program.opts<{
  input?: string;
  people?: string;
  title?: string;
  maxPhotos: string;
  privacy: string;
  force: boolean;
  dryRun: boolean;
  demo: boolean;
  deploy: boolean;
}>();
if (!options.demo && !options.people) program.error("--people include|exclude is required");
if (options.people && !["include", "exclude"].includes(options.people)) program.error("--people must be include or exclude");
const maxPhotos = Number(options.maxPhotos);
if (!Number.isInteger(maxPhotos) || maxPhotos < 12 || maxPhotos > 60) program.error("--max-photos must be an integer from 12 to 60");
if (!["hidden", "broad", "approximate", "precise"].includes(options.privacy))
  program.error("--privacy must be hidden, broad, approximate, or precise");
try {
  await runTrip({
    input: options.input,
    people: (options.people ?? "exclude") as "include" | "exclude",
    title: options.title,
    maxPhotos,
    privacy: options.privacy as "hidden" | "broad" | "approximate" | "precise",
    force: options.force,
    dryRun: options.dryRun,
    demo: options.demo,
  });
  if (options.deploy && !options.dryRun) {
    const { runStaticExport } = await import("@/lib/static-export-run");
    await runStaticExport(process.env.WANDERPAGE_WORKSPACE ?? process.cwd());
    const { deploy } = await import("./deploy");
    await deploy();
  }
} catch (error) {
  console.error(`\nWanderpage failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
