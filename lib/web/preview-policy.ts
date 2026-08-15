export type PreviewRunMode = "smoke" | "acceptance";

type PreviewEnvironment = Record<string, string | undefined>;

export function assertPreviewUrl(raw: string, allowlistedHosts: readonly string[] = []) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WANDERPAGE_PREVIEW_URL must be an absolute HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("WANDERPAGE_PREVIEW_URL must use HTTPS without embedded credentials.");
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    throw new Error("WANDERPAGE_PREVIEW_URL must point to a deployed preview, not localhost.");
  }
  if (hostname === "wanderpage.buildproven.ai" || hostname.endsWith(".buildproven.ai")) {
    throw new Error("Production Wanderpage domains are blocked by the preview acceptance harness.");
  }
  if (!allowlistedHosts.includes(hostname)) {
    throw new Error("WANDERPAGE_PREVIEW_URL must match the exact WANDERPAGE_PREVIEW_ALLOWLIST preview host.");
  }
  return url;
}

export function readPreviewRunMode(environment: PreviewEnvironment): PreviewRunMode {
  if (environment.WANDERPAGE_PREVIEW_CONFIRM !== "preview-only") {
    throw new Error("Set WANDERPAGE_PREVIEW_CONFIRM=preview-only before running hosted acceptance.");
  }
  const smoke = environment.WANDERPAGE_HOSTED_SMOKE === "1";
  const acceptance = environment.WANDERPAGE_HOSTED_ACCEPTANCE === "1";
  if (smoke === acceptance) {
    throw new Error("Set exactly one hosted run mode: WANDERPAGE_HOSTED_SMOKE=1 or WANDERPAGE_HOSTED_ACCEPTANCE=1.");
  }
  if (acceptance && environment.WANDERPAGE_HOSTED_ALLOW_GENERATION !== "1") {
    throw new Error("Full hosted acceptance requires WANDERPAGE_HOSTED_ALLOW_GENERATION=1.");
  }
  return acceptance ? "acceptance" : "smoke";
}
