// @design DES-WEB-PRIVACY
// The hosted privacy policy (BUI-2135), linked from `.claude-plugin/plugin.json` as `privacyPolicyUrl`. The static export removes this
// folder: a user's own trip site has no server, no sign-in and no cookies.
import { signupMode } from "@buildproven/mcp-oauth";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy policy — Wanderpage",
  description: "What hosted Wanderpage stores, for how long, which cookies it sets, and how to delete your data.",
};

// The names and lifetimes below are the ones `lib/web/session.ts` and `lib/web/upload-link.ts` export; this page does not import them,
// because shipped app code must not reach into lib/web (tests/cli/local-edition-imports.test.ts). tests/web/privacy-page.test.tsx
// fails when they differ. @buildproven/mcp-oauth names its sign-in cookie `<prefix>_oauth_nonce`; Wanderpage passes the prefix WANDERPAGE.
const ownerCookieName = "wanderpage_owner",
  ownerDays = 30,
  ownerTtlCookieName = "wanderpage_owner_ttl",
  ownerTtlLinkValue = "link",
  linkHours = 1,
  oauthNonceCookieName = "wanderpage_oauth_nonce";

export default function PrivacyPage() {
  // `WANDERPAGE_SIGNUP` (BUI-2215), read with the prefix the hosted MCP entry passes (`hostedPrefix`); not imported, so this page does
  // not bundle the MCP server. The root layout is force-dynamic, so each request reads the current setting.
  const open = signupMode("WANDERPAGE") === "open";
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "3rem 1.25rem", lineHeight: 1.6, fontFamily: "var(--font-sans)" }}>
      <p>
        <Link href="/">Wanderpage</Link>
      </p>
      <h1 style={{ fontFamily: "var(--font-editorial)" }}>Privacy policy</h1>
      <p>
        This policy covers hosted Wanderpage at wanderpage.buildproven.ai and the Wanderpage plugin for Claude that connects to it. The
        local edition (<code>npx @buildproven/wanderpage</code>) runs on your own computer and sends nothing to this server.
      </p>

      <h2>Who can sign in</h2>
      {open ? (
        <p>
          Any GitHub account can sign in, through GitHub OAuth. GitHub tells Wanderpage the login name of the account that signed in. Each
          account sees only its own stories. Wanderpage does not keep your GitHub password or read your repositories.
        </p>
      ) : (
        <p>
          Only the one owner can sign in, through GitHub OAuth. GitHub tells Wanderpage the login name of the account that signed in; any
          other GitHub account is refused. Wanderpage does not keep your GitHub password or read your repositories.
        </p>
      )}

      <h2>What Wanderpage stores and for how long</h2>
      <ul>
        {open ? (
          <li>
            For each account: a keyed hash of your GitHub login (not the login itself), kept so that your next sign-in finds your stories,
            and your private session, which ends {ownerDays} days after you last use it. Each account can create 3 stories and start 3
            generation runs in any 24 hours.
          </li>
        ) : null}
        <li>
          Source uploads expire after 24 hours and are deleted within 48 hours. Once a draft is finalized, its original photos are deleted.
        </li>
        <li>An unpublished draft is deleted after 30 days of inactivity, with its derived images and story text.</li>
        <li>A published story stays public until you unpublish it or delete it.</li>
      </ul>

      <h2>Cookies</h2>
      <ul>
        <li data-cookie={ownerCookieName}>
          <code>{ownerCookieName}</code>: the owner session. It is secure and HTTP-only, and only its hash is stored. It lasts {ownerDays}{" "}
          days, or {linkHours} hour when an upload link sets it.
        </li>
        <li data-cookie={ownerTtlCookieName}>
          <code>{ownerTtlCookieName}</code>: the upload-link marker, with the value {ownerTtlLinkValue}. It holds no secret; it stops the
          owner session from being renewed, so a session set by an upload link ends after {linkHours} hour.
        </li>
        <li data-cookie={oauthNonceCookieName}>
          <code>{oauthNonceCookieName}</code>: a one-time value that protects the GitHub sign-in. It lasts 10 minutes and is cleared when
          sign-in finishes.
        </li>
      </ul>
      <p>Wanderpage sets no tracking, analytics or advertising cookies.</p>

      <h2>AI processing</h2>
      <p>
        Derived contact sheets go to OpenAI only when AI generation is on (<code>WANDERPAGE_GENERATION_ENABLED=true</code>) and a draft is
        generated. OpenAI then also gets a text summary of the trip to write the story text. Original photos never go to OpenAI. When AI
        generation is off, nothing goes to OpenAI.
      </p>

      <h2>People and places</h2>
      <p>
        Wanderpage never identifies people: it does not recognize faces or put names to anyone in a photo. It never publishes exact GPS:
        locations are rounded to a broad or approximate region, or hidden, by the choice you make for each story, and photo metadata is
        removed from every published image.
      </p>

      <h2>Delete your data</h2>
      <p>
        Ask Claude to delete a story with the <code>delete_story</code> tool, or use the &ldquo;Delete this story and its media&rdquo;
        control on the story page. Deletion removes the story, its photos and its derived images, and closes public access at once.
      </p>
    </main>
  );
}
