// @design DES-WEB-MCP
// The page an upload link from `upload_photos` opens (BUI-2095). GET only shows the story title and a Continue button, so a chat or
// messaging link preview cannot use the link. Continue posts the same URL: the link is used in one conditional update, the owner cookie
// is set for 1 hour with a marker that stops the proxy renewing it, and the browser goes to the story's private page.
import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";
import { NeonUploadLinkStore } from "@/lib/web/neon-repository";
import { getStoryService } from "@/lib/web/runtime";
import { ownerCookieName, ownerCookieOptions } from "@/lib/web/session";
import { StoryServiceError, type StoryService } from "@/lib/web/story-service";
import { escapeHtml, page, pageHeaders, sameOriginForm } from "@/app/api/mcp/_hosted/link-page";
import {
  ownerTtlCookieName,
  ownerTtlLinkValue,
  uploadLinkCookieMaxAge,
  uploadLinkKey,
  UploadLinks,
  type UploadLinkClaims,
} from "@/lib/web/upload-link";

export type UploadLinkDependencies = { stories: Pick<StoryService, "getOwnedStory">; links: Pick<UploadLinks, "open" | "use"> };

const noLongerValid = "This upload link is no longer valid.";

export function createUploadLinkHandlers(dependencies: () => UploadLinkDependencies) {
  return {
    async GET(_request: Request, token: string) {
      const { stories, links } = dependencies(),
        found = await ownedLink(stories, links, token);
      if (!found) return gone();
      return page(
        200,
        "Add photos",
        `<p class="kicker">Private upload</p><h1>${escapeHtml(found.title)}</h1>` +
          "<p>Continue to this story's private page in this browser, then pick the photos to upload. The link works once.</p>" +
          `<form method="post" action="/upload/${token}"><button type="submit">Continue</button></form>`
      );
    },

    async POST(request: Request, token: string) {
      if (!sameOriginForm(request)) return page(403, "Request refused", "<h1>This request could not be verified.</h1>");
      const { stories, links } = dependencies(),
        found = await ownedLink(stories, links, token);
      if (!found || !(await links.use(found.claims))) return gone();
      const response = NextResponse.redirect(new URL(`/stories/${found.claims.storyId}`, request.url), 303),
        options = { ...ownerCookieOptions(), maxAge: uploadLinkCookieMaxAge };
      response.cookies.set(ownerCookieName, found.claims.ownerSecret, options);
      response.cookies.set(ownerTtlCookieName, ownerTtlLinkValue, options);
      for (const [name, value] of Object.entries(pageHeaders)) response.headers.set(name, value);
      return response;
    },
  };
}

/** Production wiring: the hosted StoryService and Neon `upload_links` under the session pepper's upload-link key. */
export function uploadLinkDependencies(): UploadLinkDependencies {
  const url = process.env.DATABASE_URL?.trim(),
    pepper = process.env.WANDERPAGE_SESSION_PEPPER?.trim();
  if (!url || !pepper) throw new Error("DATABASE_URL and WANDERPAGE_SESSION_PEPPER are required for upload links.");
  return { stories: getStoryService(), links: new UploadLinks({ store: new NeonUploadLinkStore(neon(url)), key: uploadLinkKey(pepper) }) };
}

/** The opened link and its story title, or undefined when the link, its story or its owner session is no longer valid. */
async function ownedLink(
  stories: UploadLinkDependencies["stories"],
  links: UploadLinkDependencies["links"],
  token: string
): Promise<{ claims: UploadLinkClaims; title: string } | undefined> {
  const opened = await links.open(token);
  if (!opened.ok) return undefined;
  try {
    const story = await stories.getOwnedStory(opened.claims.ownerSecret, opened.claims.storyId);
    return { claims: opened.claims, title: story.title };
  } catch (error) {
    if (error instanceof StoryServiceError && ["AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)) return undefined;
    throw error;
  }
}

function gone() {
  return page(
    410,
    "Link no longer valid",
    `<h1>${noLongerValid}</h1><p>Ask Claude for a new upload link: upload links work once and expire after 15 minutes.</p>`
  );
}
