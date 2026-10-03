import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StoryIndex from "@/components/StoryIndex";

// @verifies DES-SITE-HOME, ARCH-SITE, REQ-UI-07, SN-08
describe("home page for several stories", () => {
  const html = renderToStaticMarkup(
    <StoryIndex
      stories={[
        {
          slug: "oregon-coast-2026",
          title: "Oregon Coast",
          subtitle: "Four days of fog.",
          image: "/trip/generated/oregon-coast-2026/u-1-medium.webp",
        },
        { slug: "lisbon", title: "Lisbon", subtitle: "Tiles and trams." },
      ]}
    />
  );

  it("links every story by its page name with its title and subtitle", () => {
    expect(html).toContain('href="/trips/oregon-coast-2026"');
    expect(html).toContain('href="/trips/lisbon"');
    expect(html).toContain("Oregon Coast");
    expect(html).toContain("Tiles and trams.");
  });

  it("labels each cover photo for assistive technology, and copes with a story that has no photo", () => {
    expect(html).toContain('aria-label="Cover photo for Oregon Coast"');
    expect(html).toContain("url(/trip/generated/oregon-coast-2026/u-1-medium.webp)");
    expect(html).toContain('aria-label="Cover photo for Lisbon"');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
