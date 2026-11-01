// @design DES-CLI-TRIP
import { spawn } from "node:child_process";
import { PrivacyScanError, deployAfterPrivacyScan } from "@/lib/publishing/privacy";

function runVercel(outputPath: string) {
  return new Promise<void>((resolve, reject) => {
    const args = ["deploy", outputPath, "-y"];
    if (process.env.VERCEL_TOKEN) args.push("--token", process.env.VERCEL_TOKEN);
    const child = spawn("vercel", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`Vercel exited with code ${code}`))));
  });
}

/** Deploys `outputPath` to Vercel after the privacy scan passes; throws `PrivacyScanError` listing every finding otherwise. */
export async function deploy(outputPath = "out", run: (outputPath: string) => Promise<void> = runVercel) {
  const result = await deployAfterPrivacyScan({ outputPath, deploy: () => run(outputPath) });
  if (!result.deployed) throw new PrivacyScanError(result.findings);
  return result;
}
if (import.meta.url === new URL(process.argv[1] ?? "", `file://${process.cwd()}/`).href) {
  try {
    await deploy();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
