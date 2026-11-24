// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Landing from "@/components/Landing";

const ELEMENT_NODE = 1,
  TEXT_NODE = 3;

function claudeSection() {
  const document = new DOMParser().parseFromString(renderToStaticMarkup(createElement(Landing)), "text/html"),
    section = document.querySelector('section[aria-labelledby="claude-title"]');
  if (!section) throw new Error("the 'Use it in Claude' section is missing");
  return section;
}

// The step line is a CSS grid (number column + text column): every element or non-blank text
// node directly inside it becomes its own grid cell.
function gridCells(line: Element) {
  return [...line.childNodes].filter(
    node => node.nodeType === ELEMENT_NODE || (node.nodeType === TEXT_NODE && (node.textContent ?? "").trim() !== "")
  );
}

// @verifies DES-SITE-LANDING, ARCH-SITE, REQ-UI-06
describe("the 'Use it in Claude' steps (BUI-2210)", () => {
  const section = claudeSection(),
    lines = [...section.querySelectorAll("ol > li > p")];

  it("BUI-2210 R1 (REQ-UI-06): every step is one number cell and one text cell", () => {
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const cells = gridCells(line);
      expect(cells, line.textContent ?? "").toHaveLength(2);
      expect((cells[0] as Element).tagName).toBe("SPAN");
      expect(cells[0]?.textContent).toMatch(/^\d{2}$/);
      expect(cells[1]?.nodeType).toBe(ELEMENT_NODE);
    }
  });

  it("BUI-2210 R1 (REQ-UI-06): step 1 holds the claude.ai link inline, with no space before the period", () => {
    const text = gridCells(lines[0] as Element)[1] as Element,
      link = text.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://claude.ai");
    expect(link?.textContent).toBe("claude.ai");
    expect(text.textContent).toMatch(/claude\.ai\.$/);
    for (const line of lines) expect(line.textContent).not.toMatch(/\s\./);
  });

  it("BUI-2210 R2 (REQ-UI-06): names the server URL and says sign-in is invite-only", () => {
    const text = (section.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("https://wanderpage.buildproven.ai/api/mcp");
    expect(text).toMatch(/invite-only/i);
  });
});
