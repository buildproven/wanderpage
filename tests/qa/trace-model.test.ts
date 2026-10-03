import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { check, parseDocument, parseTags, render, type Model } from "../../scripts/trace-model";
import { repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);

const requirements = `## SN
### SN-01 Need
text
### REQ-X-01 Requirement
- **Needs:** SN-01
`;
const architecture = `### ARCH-X Component
- **Satisfies:** REQ-X-01
`;
const design = `### DES-X-ONE Unit
- **Realizes:** ARCH-X
- **Code:** lib/x.ts
`;
const items = () => [
  ...parseDocument(requirements, "r.md", ["SN", "REQ"]).items,
  ...parseDocument(architecture, "a.md", ["ARCH"]).items,
  ...parseDocument(design, "d.md", ["DES"]).items,
];
const complete = (): Model => ({
  items: items(),
  codeFiles: ["lib/x.ts"],
  testFiles: ["tests/x.test.ts"],
  designTags: [{ file: "lib/x.ts", line: 1, ids: ["DES-X-ONE"], subject: "*" }],
  verifyTags: [{ file: "tests/x.test.ts", line: 1, ids: ["DES-X-ONE", "ARCH-X", "REQ-X-01", "SN-01"], subject: "*" }],
});

// @verifies DES-QA-TRACE, ARCH-QA
describe("traceability model", () => {
  it("parses headings, link fields, and code lists", () => {
    const design = parseDocument("### DES-A-B Title here\n- **Realizes:** ARCH-A, ARCH-B\n- **Code:** `lib/a.ts`, lib/b.ts\n", "d.md", [
      "DES",
    ]);
    expect(design.errors).toEqual([]);
    expect(design.items[0]).toMatchObject({ id: "DES-A-B", title: "Title here", up: ["ARCH-A", "ARCH-B"], code: ["lib/a.ts", "lib/b.ts"] });
  });

  it("reports an identifier in the wrong document and a wrong link field", () => {
    expect(parseDocument("### REQ-X-01 Misplaced\n", "a.md", ["ARCH"]).errors[0]).toContain("does not belong");
    expect(parseDocument("### REQ-X-01 R\n- **Satisfies:** SN-01\n", "r.md", ["REQ"]).errors[0]).toContain("wrong link field");
  });

  it("finds tags and the test they annotate", () => {
    const tags = parseTags(
      '// @verifies REQ-A-01, DES-B-02\ndescribe("the subject", () => {})\n// @verifies SN-01\nconst x = 1;\n',
      "t.ts",
      "verifies"
    );
    expect(tags).toEqual([
      { file: "t.ts", line: 1, ids: ["REQ-A-01", "DES-B-02"], subject: "the subject" },
      { file: "t.ts", line: 3, ids: ["SN-01"], subject: "*" },
    ]);
    expect(parseTags("// @design DES-A-B\n", "c.ts", "verifies")).toEqual([]);
  });

  it("accepts a complete chain", () => {
    expect(check(complete())).toEqual([]);
  });

  it.each([
    [
      "a requirement with no need",
      (model: Model) => (model.items.find(item => item.id === "REQ-X-01")!.up = []),
      'REQ-X-01: no "Needs" link',
    ],
    [
      "a need nothing realizes",
      (model: Model) => (model.items.find(item => item.id === "REQ-X-01")!.up = ["SN-99"]),
      "SN-01: no requirement realizes it",
    ],
    [
      "a component with no design unit",
      (model: Model) => (model.items = model.items.filter(item => item.level !== "DES")),
      "ARCH-X: no design unit realizes it",
    ],
    [
      "a design unit without code",
      (model: Model) => (model.items.find(item => item.id === "DES-X-ONE")!.code = []),
      "DES-X-ONE: lists no Code files",
    ],
    ["a source file without a tag", (model: Model) => (model.designTags = []), "lib/x.ts: source file has no @design tag"],
    [
      "an unlisted tagged file",
      (model: Model) =>
        model.codeFiles.push("lib/y.ts") && model.designTags.push({ file: "lib/y.ts", line: 1, ids: ["DES-X-ONE"], subject: "*" }),
      "lib/y.ts: tagged DES-X-ONE but not listed",
    ],
    [
      "a test file without a tag",
      (model: Model) => model.testFiles.push("tests/orphan.test.ts"),
      "tests/orphan.test.ts: test file has no @verifies tag",
    ],
    [
      "an unverified requirement",
      (model: Model) => (model.verifyTags[0]!.ids = ["DES-X-ONE", "ARCH-X", "SN-01"]),
      "REQ-X-01: no system test verifies it",
    ],
    ["a tag naming nothing", (model: Model) => model.verifyTags[0]!.ids.push("REQ-NOPE-01"), "@verifies REQ-NOPE-01 does not exist"],
  ])("fails on %s", (_name, mutate, expected) => {
    const model = complete();
    mutate(model);
    expect(check(model).join("\n")).toContain(expected);
  });

  it("renders every item with its tests in the matrix", () => {
    const matrix = render(complete());
    expect(matrix).toContain("| REQ-X-01 | Requirement | SN-01 | `tests/x.test.ts` |");
    expect(matrix).toContain("`lib/x.ts`");
  });
});

// @verifies ARCH-QA, REQ-QA-01, SN-11
describe("repository traceability gate", () => {
  it("passes for the repository's own requirements, architecture, design, code, and tests", async () => {
    const outcome = await execute("pnpm", ["-s", "trace"], { cwd: repoRoot }).catch((error: { stdout: string; stderr: string }) => error);
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("Traceability OK");
  }, 60_000);
});
