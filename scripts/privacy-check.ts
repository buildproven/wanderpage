import { resolve } from "node:path";
import { validateStaticExport } from "@/lib/publishing/privacy";

const root = resolve(process.env.WANDERPAGE_EXPORT ?? "out");
const secretValues = [process.env.OPENAI_API_KEY, process.env.VERCEL_TOKEN].filter((value): value is string => Boolean(value));
const { files, errors } = await validateStaticExport(root, secretValues);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Privacy validation passed: ${files.length} exported files, no metadata, local paths, reports, or secrets.`);
