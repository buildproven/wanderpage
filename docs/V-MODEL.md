# How Wanderpage is verified: the V-model

Every level of specification on the left has a matching level of verification on the right, and a script checks that the two sides line up.

```
 Stakeholder needs  (SN-xx)     ◄────────────────────────────►  Acceptance tests
   docs/REQUIREMENTS.md                                           "does it solve the person's problem?"
      │                                                                   ▲
 System requirements (REQ-xx)   ◄────────────────────────────►  System tests
   docs/REQUIREMENTS.md                                           whole pipeline, browser, CLI, hosted service
         │                                                                ▲
    Architecture (ARCH-xx)      ◄────────────────────────────►  Integration tests
      docs/ARCHITECTURE.md                                        components working together
            │                                                             ▲
       Detailed design (DES-xx) ◄────────────────────────────►  Unit tests
         docs/DESIGN.md                                           one design unit's rules
               │                                                          ▲
               └──────────────────►  Code  ◄──────────────────────────────┘
                                  every file carries `@design DES-xx`
```

## Identifiers and links

| Level        | ID form         | Defined in             | Links up with      | Realized / verified by              |
| ------------ | --------------- | ---------------------- | ------------------ | ----------------------------------- |
| Need         | `SN-01`         | `docs/REQUIREMENTS.md` | —                  | requirements; **acceptance** tests  |
| Requirement  | `REQ-AREA-01`   | `docs/REQUIREMENTS.md` | `Needs: SN-…`      | architecture; **system** tests      |
| Architecture | `ARCH-NAME`     | `docs/ARCHITECTURE.md` | `Satisfies: REQ-…` | design units; **integration** tests |
| Design unit  | `DES-AREA-NAME` | `docs/DESIGN.md`       | `Realizes: ARCH-…` | code files; **unit** tests          |

A design unit also lists `Code:` — the exact source files that implement it.

In source files, one comment names the unit the file belongs to:

```ts
// @design DES-PHOTO-SCORE
```

In test files, a comment above a `describe`, `it`, or `test` names what it verifies. Any level may be listed, and the level of the ID decides
what kind of evidence it is:

```ts
// @verifies DES-PUB-SLUG, ARCH-PUBLISH, REQ-PUB-05
describe("trip page names", () => { … });
```

## The gate

`pnpm trace` (part of `pnpm check`, so part of every pull request) fails when:

- an ID is duplicated, in the wrong document, or links to the wrong level;
- a need, requirement, or component is not realized one level down;
- a design unit lists a file that does not exist or does not carry its `@design` tag, or a tagged file is not listed by its unit;
- a source file has no `@design` tag, or a test file has no `@verifies` tag;
- any need, requirement, component, or design unit has no test at its own level;
- `docs/TRACEABILITY.md` (the generated matrix) is out of date. Regenerate it with `pnpm trace:write`.

Source files in scope: `app/`, `assets/`, `components/`, `lib/`, `scripts/`, `bin/`, `workflows/`, and `proxy.ts`. Test files in scope: `tests/` and
`components/*.test.tsx`.

## Changing the product

1. New or changed behavior starts as a requirement (and a need, if it is new). Edit `docs/REQUIREMENTS.md`.
2. Name the component that satisfies it in `docs/ARCHITECTURE.md`, and the design unit and files in `docs/DESIGN.md`.
3. Write the tests first and tag them with `@verifies`; tag new code with `@design`.
4. Run `pnpm trace:write`, then `pnpm check`.

## What is verified, and what is not

- Everything above runs without secrets, network, or paid services. The default `pnpm test` uses a deterministic AI provider and mocked
  network sources; it also builds the real site and drives it in Chromium.
- `pnpm test:live` sends a small contact sheet to OpenAI. It needs `OPENAI_API_KEY`, costs a little, and is therefore not part of the gate.
  It is an additional check for `REQ-AI-01`, not its only evidence.
- The hosted creator's _credentialed_ acceptance run (`pnpm hosted:preview`, see [`DEPLOYMENT.md`](DEPLOYMENT.md)) needs real Vercel, Neon, Blob,
  and OpenAI accounts and an operator's consent to spend money. Its deterministic behavior is covered by the tests above; the live run is
  what must pass before the hosted creator stops saying "coming soon".
