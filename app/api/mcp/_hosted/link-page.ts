// @design DES-WEB-MCP
// What the one-time link pages share (BUI-2095 upload, BUI-2146 download): the small private HTML page, its escaping, its response headers
// and the same-origin form check that keeps a cross-site request or a link preview from spending a link.
const formTypes = new Set(["application/x-www-form-urlencoded", "multipart/form-data"]);

export const pageHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "same-origin", "X-Robots-Tag": "noindex" };

export function sameOriginForm(request: Request) {
  const origin = request.headers.get("origin"),
    contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return origin === new URL(request.url).origin && formTypes.has(contentType);
}

export function page(status: number, title: string, body: string) {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Wanderpage</title><style>` +
    "body{font-family:system-ui,sans-serif;margin:0;padding:12vh 6vw;background:#f7f4ee;color:#1d1b18}" +
    "main{max-width:34rem}.kicker{text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;color:#6b645a}" +
    "button{font:inherit;padding:.8rem 1.6rem;border:0;border-radius:999px;background:#1d1b18;color:#fff;cursor:pointer}" +
    `</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { ...pageHeaders, "Content-Type": "text/html; charset=utf-8" } });
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => entities[character] ?? character);
}
