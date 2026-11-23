// @design DES-WEB-MCP
// The page a download link from `download_page` opens (BUI-2146). GET only shows the story title and a Download button, so a chat or
// messaging link preview cannot use the link. Download posts the same URL: the archive is built first (so a missing image never spends
// the link), the link is then used in one conditional update, and the answer is a ZIP of the story's `index.html` and derived images.
import { get } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import { NeonDownloadLinkStore } from "@/lib/web/neon-repository";
import { DownloadLinks, downloadLinkKey, type DownloadLinkClaims } from "@/lib/web/download-link";
import { buildPageArchive, PageArchiveError, zipChunks, type DerivativeReader } from "@/lib/web/page-archive";
import { getStoryService } from "@/lib/web/runtime";
import { StoryServiceError, type StoryService } from "@/lib/web/story-service";
import type { Story } from "@/lib/web/types";
import { escapeHtml, page, pageHeaders, sameOriginForm } from "@/app/api/mcp/_hosted/link-page";

export type DownloadLinkDependencies = {
  stories: Pick<StoryService, "getOwnedStory">;
  links: Pick<DownloadLinks, "open" | "use">;
  readDerivative: DerivativeReader;
};

const noLongerValid = "This download link is no longer valid.";
/** The statuses `download_page` accepts: a finished page, private or public. */
export const downloadableStatuses: ReadonlySet<Story["status"]> = new Set(["draft", "published"]);

export function createDownloadHandlers(dependencies: () => DownloadLinkDependencies) {
  return {
    async GET(_request: Request, token: string) {
      const { stories, links } = dependencies(),
        found = await ownedLink(stories, links, token);
      if (!found) return gone();
      return page(
        200,
        "Download your page",
        `<p class="kicker">Private download</p><h1>${escapeHtml(found.story.title)}</h1>` +
          "<p>Download this story as a ZIP: an <code>index.html</code> and its images. Unzip it and open <code>index.html</code>, " +
          "or put the folder on any web host. The link works once.</p>" +
          `<form method="post" action="/download/${token}"><button type="submit">Download</button></form>`
      );
    },

    async POST(request: Request, token: string) {
      if (!sameOriginForm(request)) return page(403, "Request refused", "<h1>This request could not be verified.</h1>");
      const { stories, links, readDerivative } = dependencies(),
        found = await ownedLink(stories, links, token);
      if (!found) return gone();
      let archive: Awaited<ReturnType<typeof buildPageArchive>>;
      try {
        archive = await buildPageArchive(found.story, readDerivative);
      } catch (error) {
        if (!(error instanceof PageArchiveError)) throw error;
        // The link stays unused: the owner can press Download again.
        if (error.code === "NO_MANIFEST") return gone();
        return page(
          503,
          "Download unavailable",
          "<h1>The page could not be packed.</h1><p>Wait a moment and try again, or ask Claude for a new download link.</p>"
        );
      }
      if (!(await links.use(found.claims))) return gone();
      const chunks = zipChunks(archive.entries);
      let next = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks[next++];
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        {
          headers: {
            ...pageHeaders,
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${archive.fileName}"`,
            "X-Content-Type-Options": "nosniff",
          },
        }
      );
    },
  };
}

/** Production wiring: the hosted StoryService, Neon `download_links` under the session pepper's download-link key, and private Blob. */
export function downloadLinkDependencies(): DownloadLinkDependencies {
  const url = process.env.DATABASE_URL?.trim(),
    pepper = process.env.WANDERPAGE_SESSION_PEPPER?.trim();
  if (!url || !pepper) throw new Error("DATABASE_URL and WANDERPAGE_SESSION_PEPPER are required for download links.");
  return {
    stories: getStoryService(),
    links: new DownloadLinks({ store: new NeonDownloadLinkStore(neon(url)), key: downloadLinkKey(pepper) }),
    readDerivative: readBlobDerivative,
  };
}

/** A derived image from private Blob, by the media file name `<revision>--<run>--<name>` the page's `/api/media` path carries. */
const readBlobDerivative: DerivativeReader = async (storyId, filename) => {
  const [revision, runId, ...nameParts] = filename.split("--"),
    object = await get(`derivatives/${storyId}/${revision}/${runId}/${nameParts.join("--")}`, { access: "private", useCache: false });
  if (!object || object.statusCode !== 200) return undefined;
  return new Uint8Array(await new Response(object.stream).arrayBuffer());
};

/** The opened link and its story, or undefined when the link, its story, its owner session or its story's state is no longer valid. */
async function ownedLink(
  stories: DownloadLinkDependencies["stories"],
  links: DownloadLinkDependencies["links"],
  token: string
): Promise<{ claims: DownloadLinkClaims; story: Story } | undefined> {
  const opened = await links.open(token);
  if (!opened.ok) return undefined;
  try {
    const story = await stories.getOwnedStory(opened.claims.ownerSecret, opened.claims.storyId);
    return downloadableStatuses.has(story.status) ? { claims: opened.claims, story } : undefined;
  } catch (error) {
    if (error instanceof StoryServiceError && ["AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)) return undefined;
    throw error;
  }
}

function gone() {
  return page(
    410,
    "Link no longer valid",
    `<h1>${noLongerValid}</h1><p>Ask Claude for a new download link: download links work once and expire after 15 minutes.</p>`
  );
}
