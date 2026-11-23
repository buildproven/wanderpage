import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Landing from "@/components/Landing";
import nextConfig from "@/next.config";
import { proxy } from "@/proxy";

function visibleText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

// @verifies DES-WEB-HTTP, ARCH-WEB-EDGE, REQ-WEB-10
describe("the retired browser creator (BUI-2148)", () => {
  it("BUI-2148 R1: a request for /create is redirected (308) to /", () => {
    for (const path of ["/create", "/create/"]) {
      const response = proxy(new NextRequest(`https://wanderpage.example${path}`));
      expect(response.status).toBe(308);
      expect(new URL(response.headers.get("location") ?? "").toString()).toBe("https://wanderpage.example/");
    }
  });

  it("BUI-2148 R1: next.config.ts redirects /create permanently (308) to /", async () => {
    type Built = { redirects?: () => Promise<{ source: string; destination: string; permanent?: boolean }[]> };
    const built = (await (nextConfig as unknown as (phase: string, context: { defaultConfig: object }) => Promise<Built>)("phase-test", {
      defaultConfig: {},
    })) as Built;
    expect(await built.redirects?.()).toContainEqual({ source: "/create", destination: "/", permanent: true });
  });

  it("BUI-2148 R1: the redirect keeps no owner cookie renewal and other routes are not redirected", () => {
    const redirected = proxy(
      new NextRequest("https://wanderpage.example/create", { headers: { cookie: "wanderpage_owner=opaque-value" } })
    );
    expect(redirected.cookies.get("wanderpage_owner")).toBeUndefined();
    for (const path of [
      "/",
      "/stories/story-id",
      "/upload/link-id",
      "/download/link-id",
      "/s/slug",
      "/trips/slug",
      "/demo",
      "/privacy",
      "/created",
    ]) {
      const response = proxy(new NextRequest(`https://wanderpage.example${path}`));
      expect(response.headers.get("location")).toBeNull();
      expect(response.status).toBe(200);
    }
  });

  it("BUI-2148 R3: WebCreator and the /create page are removed; the kept routes still exist", () => {
    expect(existsSync("components/WebCreator.tsx")).toBe(false);
    expect(existsSync("app/create")).toBe(false);
    for (const route of [
      "app/stories/[storyId]/page.tsx",
      "app/upload/[token]",
      "app/download/[token]",
      "app/s/[slug]/page.tsx",
      "app/trips/[slug]/page.tsx",
      "app/demo",
      "app/privacy/page.tsx",
    ])
      expect(existsSync(route), route).toBe(true);
  });
});

// @verifies DES-SITE-LANDING, ARCH-SITE, REQ-UI-06
describe("the landing page points to the Claude plugin (BUI-2148)", () => {
  const html = renderToStaticMarkup(createElement(Landing)),
    text = visibleText(html);

  it("BUI-2148 R2: has no link to /create", () => {
    expect(html).not.toMatch(/href="\/create/);
    expect(text).not.toMatch(/Create a (private )?story/);
    // No switch may bring the link back: the component source names no /create route at all.
    expect(readFileSync("components/Landing.tsx", "utf8")).not.toContain("/create");
  });

  it("BUI-2148 R2: shows one 'Use it in Claude' section with the plugin steps in order", () => {
    expect(text.match(/Use it in Claude/g)).toHaveLength(1);
    const section = /<section[^>]*aria-labelledby="claude-title"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "",
      steps = [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(match => visibleText(match[1] ?? "").trim());
    expect(visibleText(section)).toContain("Use it in Claude");
    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatch(/Connect the Wanderpage plugin in claude\.ai/);
    expect(section).toContain('href="https://claude.ai"');
    expect(steps[1]).toContain('Say "make a trip page from my photos"');
    expect(steps[2]).toMatch(/Open the upload link/);
    expect(steps[3]).toMatch(/Publish/);
    expect(steps[4]).toMatch(/Download the ZIP/);
  });
});
