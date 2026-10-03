// @design DES-QA-TRACE
export type Level = "SN" | "REQ" | "ARCH" | "DES";

export type Item = {
  id: string;
  level: Level;
  title: string;
  doc: string;
  up: string[];
  code: string[];
};

export type Tag = { file: string; line: number; ids: string[]; subject: string };

export type Model = {
  items: Item[];
  designTags: Tag[];
  verifyTags: Tag[];
  codeFiles: string[];
  testFiles: string[];
};

export const idPattern = /\b(?:SN|REQ|ARCH|DES)(?:-[A-Z0-9]+)+\b/g;
const levelOf = (id: string): Level => id.split("-")[0] as Level;
const upLevel: Record<Level, Level | undefined> = { SN: undefined, REQ: "SN", ARCH: "REQ", DES: "ARCH" };
const upField: Record<Level, string | undefined> = { SN: undefined, REQ: "Needs", ARCH: "Satisfies", DES: "Realizes" };
const headingPattern = /^#{2,4}\s+((?:SN|REQ|ARCH|DES)(?:-[A-Z0-9]+)+)\s+(.+)$/;
const fieldPattern = /^- \*\*(Needs|Satisfies|Realizes|Code):\*\*\s*(.+)$/;

export function parseDocument(text: string, doc: string, levels: Level[]): { items: Item[]; errors: string[] } {
  const items: Item[] = [],
    errors: string[] = [];
  let current: Item | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const heading = headingPattern.exec(line);
    if (heading) {
      const id = heading[1]!;
      if (!levels.includes(levelOf(id))) errors.push(`${doc}:${index + 1}: ${id} does not belong in ${doc}`);
      current = { id, level: levelOf(id), title: heading[2]!.trim(), doc, up: [], code: [] };
      items.push(current);
      continue;
    }
    const field = fieldPattern.exec(line);
    if (field && current) {
      const values = field[2]!
        .split(",")
        .map(value => value.trim().replace(/^`|`$/g, ""))
        .filter(Boolean);
      if (field[1] === "Code") current.code.push(...values);
      else if (field[1] === upField[current.level]) current.up.push(...values);
      else errors.push(`${doc}:${index + 1}: ${current.id} uses the wrong link field "${field[1]}"`);
    }
  }
  return { items, errors };
}

const tagPattern = /@(design|verifies)\s+((?:(?:SN|REQ|ARCH|DES)(?:-[A-Z0-9]+)+(?:\s*,\s*)?)+)/;
const subjectPattern = /\b(?:describe|it|test)\(\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)')/;

export function parseTags(text: string, file: string, kind: "design" | "verifies"): Tag[] {
  const lines = text.split("\n"),
    tags: Tag[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:\/\/|\/\*|\*)/.test(line) ? tagPattern.exec(line) : null;
    if (!match || match[1] !== kind) continue;
    const ids = match[2]!.match(idPattern) ?? [];
    let subject = "*";
    for (const following of lines.slice(index + 1, index + 4)) {
      const found = subjectPattern.exec(following);
      if (found) {
        subject = found[1] ?? found[2] ?? found[3] ?? "*";
        break;
      }
    }
    tags.push({ file, line: index + 1, ids, subject });
  }
  return tags;
}

export function check(model: Model): string[] {
  const errors: string[] = [],
    byId = new Map<string, Item>();
  for (const item of model.items) {
    if (byId.has(item.id)) errors.push(`${item.doc}: duplicate id ${item.id}`);
    byId.set(item.id, item);
  }
  const designIds = new Set(model.items.filter(item => item.level === "DES").map(item => item.id));
  const children = new Map<string, Set<string>>();
  for (const item of model.items) {
    const parentLevel = upLevel[item.level];
    if (!parentLevel) continue;
    if (!item.up.length) errors.push(`${item.id}: no "${upField[item.level]}" link to a ${parentLevel}`);
    for (const parent of item.up) {
      if (byId.get(parent)?.level !== parentLevel) errors.push(`${item.id}: "${parent}" is not a ${parentLevel}`);
      children.set(parent, (children.get(parent) ?? new Set()).add(item.id));
    }
  }
  for (const item of model.items) {
    const child = { SN: "requirement", REQ: "architecture component", ARCH: "design unit", DES: undefined }[item.level];
    if (child && !children.get(item.id)?.size) errors.push(`${item.id}: no ${child} realizes it`);
  }

  const taggedBy = new Map<string, string[]>();
  for (const tag of model.designTags)
    for (const id of tag.ids) {
      if (!designIds.has(id)) errors.push(`${tag.file}:${tag.line}: @design ${id} is not a design unit`);
      taggedBy.set(id, [...(taggedBy.get(id) ?? []), tag.file]);
    }
  for (const file of model.codeFiles)
    if (!model.designTags.some(tag => tag.file === file && tag.ids.length)) errors.push(`${file}: source file has no @design tag`);
  for (const item of model.items.filter(entry => entry.level === "DES")) {
    if (!item.code.length) errors.push(`${item.id}: lists no Code files`);
    for (const file of item.code) {
      if (!model.codeFiles.includes(file)) errors.push(`${item.id}: listed file ${file} does not exist or is out of scope`);
      else if (!taggedBy.get(item.id)?.includes(file)) errors.push(`${file}: listed by ${item.id} but lacks "@design ${item.id}"`);
    }
    for (const file of taggedBy.get(item.id) ?? [])
      if (!item.code.includes(file)) errors.push(`${file}: tagged ${item.id} but not listed in its Code field`);
  }

  const verified = new Map<string, number>();
  for (const tag of model.verifyTags)
    for (const id of tag.ids) {
      if (!byId.has(id)) errors.push(`${tag.file}:${tag.line}: @verifies ${id} does not exist`);
      verified.set(id, (verified.get(id) ?? 0) + 1);
    }
  for (const file of model.testFiles)
    if (!model.verifyTags.some(tag => tag.file === file && tag.ids.length)) errors.push(`${file}: test file has no @verifies tag`);
  const verifier = { SN: "acceptance", REQ: "system", ARCH: "integration", DES: "unit" } as const;
  for (const item of model.items) if (!verified.get(item.id)) errors.push(`${item.id}: no ${verifier[item.level]} test verifies it`);
  return errors;
}

const levelName: Record<Level, string> = {
  SN: "Stakeholder need",
  REQ: "Requirement",
  ARCH: "Architecture component",
  DES: "Design unit",
};

export function render(model: Model): string {
  const out: string[] = [
    "# Traceability matrix",
    "",
    "<!-- Generated by `pnpm trace:write`. Do not edit; `pnpm trace` fails when this file is stale. -->",
    "",
    "Every row is checked on each `pnpm check`: links must resolve, every item must be realized one level down, and every item must be",
    "verified by at least one test at its V-model level (need → acceptance, requirement → system, architecture → integration,",
    "design → unit).",
    "",
  ];
  const tests = (id: string) =>
    model.verifyTags
      .filter(tag => tag.ids.includes(id))
      .map(tag => `\`${tag.file}\`${tag.subject === "*" ? "" : ` › ${tag.subject.replace(/\|/g, "\\|")}`}`)
      .sort();
  const sorted = (items: Item[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  for (const level of ["SN", "REQ", "ARCH", "DES"] as Level[]) {
    out.push(`## ${levelName[level]}s`, "");
    const header = ["ID", "Title", level === "SN" ? "Realized by" : `Traces up to`];
    if (level === "DES") header.push("Code");
    header.push({ SN: "Acceptance tests", REQ: "System tests", ARCH: "Integration tests", DES: "Unit tests" }[level]);
    out.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
    for (const item of sorted(model.items.filter(entry => entry.level === level))) {
      const upward =
        level === "SN"
          ? model.items
              .filter(entry => entry.up.includes(item.id))
              .map(entry => entry.id)
              .join(", ")
          : item.up.join(", ");
      const cells = [item.id, item.title, upward];
      if (level === "DES") cells.push(item.code.map(file => `\`${file}\``).join("<br>"));
      cells.push(tests(item.id).join("<br>"));
      out.push(`| ${cells.join(" | ")} |`);
    }
    out.push("");
  }
  return out.join("\n");
}
