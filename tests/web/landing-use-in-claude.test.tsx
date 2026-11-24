import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Landing from "@/components/Landing";

function visibleText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Splits an element's inner HTML into its top-level children: elements (with their content) and text runs.
function topLevelChildren(inner: string) {
  const children: string[] = [];
  let depth = 0,
    current = "";
  for (const part of inner.split(/(<[^>]+>)/).filter(Boolean)) {
    const isTag = part.startsWith("<"),
      closing = part.startsWith("</"),
      selfClosing = part.endsWith("/>");
    if (depth === 0 && !isTag) {
      children.push(part);
      continue;
    }
    current += part;
    if (isTag && !selfClosing) depth += closing ? -1 : 1;
    if (depth === 0) {
      children.push(current);
      current = "";
    }
  }
  return children;
}

// @verifies DES-SITE-LANDING, ARCH-SITE, REQ-UI-06
describe("the landing 'Use it in Claude' section (BUI-2210)", () => {
  const html = renderToStaticMarkup(createElement(Landing)),
    section = /<section[^>]*aria-labelledby="claude-title"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "",
    stepCells = [...section.matchAll(/<li[^>]*><p[^>]*>([\s\S]*?)<\/p><\/li>/g)].map(match => match[1] ?? "");

  it("REQ-UI-06 BUI-2210 R1: each step is the number plus one text element in its grid cell", () => {
    expect(stepCells).toHaveLength(5);
    for (const cell of stepCells) {
      // The <p> is a two-column grid: only the step number and one element may be its children, so nothing wraps into a new cell.
      const children = topLevelChildren(cell).filter(child => child.trim() !== "");
      expect(children, cell).toHaveLength(2);
      expect(children[0]).toMatch(/^<span[^>]*>\d{2}<\/span>$/);
      expect(children[1]).toMatch(/^<[a-z]+[^>]*>[\s\S]*<\/[a-z]+>$/);
    }
  });

  it("REQ-UI-06 BUI-2210 R1: step 1 holds the claude.ai link inline, with no space before the period", () => {
    const [, stepOne = ""] = topLevelChildren(stepCells[0] ?? "").filter(child => child.trim() !== "");
    expect(stepOne).toContain('<a href="https://claude.ai"');
    expect(stepOne).toMatch(/claude\.ai<\/a>\./);
    expect(visibleText(stepOne)).toMatch(/^Connect the Wanderpage plugin in claude\.ai/);
    expect(stepOne).not.toMatch(/\s\./);
  });

  it("REQ-UI-06 BUI-2210 R2: the section names the server URL and says sign-in is invite-only", () => {
    const text = visibleText(section);
    expect(text).toContain("https://wanderpage.buildproven.ai/api/mcp");
    expect(text).toMatch(/invite-only/i);
  });
});
