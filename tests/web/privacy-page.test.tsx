import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata } from "@/app/privacy/page";
import { hostedPrefix } from "@/app/api/mcp/_hosted/http";
import { uploadConsentText } from "@/lib/consent";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";
import { ownerTtlCookieName, ownerTtlLinkValue, uploadLinkCookieMaxAge } from "@/lib/web/upload-link";

const html = renderToStaticMarkup(<PrivacyPage />),
  text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    // Inline elements (`<code>`) become spaces above; close them up next to brackets so phrases read as written.
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");

function serverOnlyFolders(script: string) {
  const list = /for \(const serverOnly of \[([\s\S]*?)\]\)/.exec(script)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

// @verifies DES-WEB-PRIVACY, ARCH-WEB-UI, REQ-WEB-02, REQ-WEB-07
describe("the hosted privacy policy page (BUI-2135)", () => {
  it("BUI-2135 R1: states the retention periods the consent text promises", () => {
    // uploadConsentText is the disclosure every hosted upload page shows; the policy must say the same periods.
    const consent = uploadConsentText;
    expect(consent).toContain("source uploads expiring after 24 hours and being automatically deleted within 48 hours");
    expect(consent).toContain("automatic deletion of an unpublished draft after 30 days of inactivity");
    expect(metadata.title).toMatch(/privacy/i);
    expect(text).toMatch(/Source uploads expire after 24 hours and are deleted within 48 hours/);
    expect(text).toMatch(/An unpublished draft is deleted after 30 days of inactivity/);
    expect(text).toMatch(/A published story stays public until you unpublish it or delete it/);
  });

  it("BUI-2135 R2: names the one owner and GitHub OAuth as the only sign-in", () => {
    expect(text).toMatch(/Only the one owner can sign in/);
    expect(text).toMatch(/through GitHub OAuth/);
  });

  it("BUI-2135 R2: lists each cookie by the name and lifetime the code sets, and no tracking cookies", async () => {
    const ownerDays = ownerCookieOptions().maxAge / (24 * 60 * 60),
      linkHours = uploadLinkCookieMaxAge / (60 * 60),
      nonceCookieName = `${hostedPrefix.toLowerCase()}_oauth_nonce`;
    // @buildproven/mcp-oauth names its sign-in cookie `<prefix>_oauth_nonce` from the prefix Wanderpage passes it.
    const oauthLibrary = await readFile("node_modules/@buildproven/mcp-oauth/dist/oauth-server.js", "utf8");
    expect(oauthLibrary).toContain("const nonceCookieName = `${slug}_oauth_nonce`;");
    expect(oauthLibrary).toContain("const STATE_SECONDS = 10 * 60;");
    expect(ownerDays).toBe(30);
    expect(linkHours).toBe(1);

    const cookies = [...html.matchAll(/<li data-cookie="([^"]+)">([\s\S]*?)<\/li>/g)].map(match => ({
      name: match[1],
      text: (match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
    }));
    expect(cookies.map(cookie => cookie.name)).toEqual([ownerCookieName, ownerTtlCookieName, nonceCookieName]);
    const [owner, marker, nonce] = cookies;
    expect(owner?.text).toContain(`lasts ${ownerDays} days`);
    expect(owner?.text).toContain(`${linkHours} hour when an upload link sets it`);
    expect(marker?.text).toContain(`value ${ownerTtlLinkValue}`);
    expect(marker?.text).toContain(`${linkHours} hour`);
    expect(nonce?.text).toMatch(/GitHub sign-in/);
    expect(nonce?.text).toContain("lasts 10 minutes");
    expect(text).toMatch(/Wanderpage sets no tracking, analytics or advertising cookies/);
  });

  it("BUI-2135 R2: sends contact sheets to OpenAI only when the operator turns AI generation on", async () => {
    // lib/web/story-service.ts and app/create/page.tsx read the same switch.
    const service = await readFile("lib/web/story-service.ts", "utf8");
    expect(service).toContain('process.env.WANDERPAGE_GENERATION_ENABLED === "true"');
    expect(text).toMatch(/contact sheets go to OpenAI only when AI generation is on \(WANDERPAGE_GENERATION_ENABLED=true\)/);
    expect(text).toMatch(/Original photos never go to OpenAI/);
  });

  it("BUI-2135 R2: says people are never identified, exact GPS is never published, and how to delete data", () => {
    expect(text).toMatch(/never identifies people/);
    expect(text).toMatch(/never publishes exact GPS/);
    expect(text).toContain("delete_story");
    expect(text).toMatch(/Delete this story and its media/);
  });

  it("BUI-2135 R4: the static export removes app/privacy with the other hosted-only folders", async () => {
    const removed = serverOnlyFolders(await readFile("scripts/static-export.ts", "utf8"));
    expect(removed).toEqual(expect.arrayContaining(["app/privacy", "app/api", "app/oauth", "app/upload"]));
  });
});
