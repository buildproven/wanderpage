# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Local-first software that turns a folder of travel photos into a curated static
trip page. Preserve originals, never identify people, never publish exact GPS,
and omit unsupported location claims.

Use pnpm. Run `pnpm check` before shipping. GitHub pull requests must pass the
QA Architect workflow, `keel gate --base main --card <card.md>`, and an independent
review (`/code-review` in Claude Code, `/review` in Codex) before reaching `main`;
merge after green CI.

## Commands

- `pnpm check` — typecheck + lint + trace + full `pnpm test` (the ship gate; `pnpm test` also builds, exports, runs the privacy check and Playwright).
- `pnpm test:unit` (vitest only), `pnpm test:fast` (skips integration/live), `pnpm test:medium` (also skips e2e).
- One test: `pnpm vitest run tests/site/share-metadata.test.ts` or `-t "name"`. One e2e: `pnpm playwright test tests/e2e/viewer.spec.ts --project=chromium` (projects: `chromium`, `mobile`).
- `pnpm studio` (local UI), `pnpm trip:demo` (demo trip), `pnpm static:export` (builds `out/`), `pnpm privacy` (scans output for leaks), `pnpm dev`.
- `pnpm trace:write` regenerates `docs/TRACEABILITY.md`; run it after changing requirements, design units, or `@verifies`/`@design` tags.
- Keel repo: `keel gate --base main --card <card.md>` before opening a PR.

## Architecture

- **Pipeline** (`lib/pipeline`): discover → ingest → analyze → locate → select → write → enrich → publish → report. Components and requirement IDs are in `docs/ARCHITECTURE.md`. `lib/selection` is pure (no I/O) so privacy rules stay testable. AI sits behind an `AIProvider` interface (OpenAI plus deterministic mock) in `lib/ai`.
- **Entry points** are all in `scripts/` (Studio, CLI, agent CLI, deploy, release). `bin/local-edition.js` is the shipped `npx @buildproven/wanderpage` launcher: an npm-only project copy with no pnpm and no hosted deps.
- **Static export**: `scripts/static-export.ts` copies `app/`, `components/`, `lib/`, `public/`, `data/` to a temp dir and swaps in `assets/static-trip-page.tsx` and `assets/static-home-page.tsx`. Pages in `app/` therefore need a static counterpart in `assets/` when they change.
- **Hosted creator** (`app/create`, `app/api`, `lib/web`, `db/`) is built and tested but deliberately not part of v1; do not link it from the product.
- **Share metadata**: `lib/share-metadata.ts`; `WANDERPAGE_SITE_URL` must be a bare origin (story images are root-absolute).

## V-model traceability

`docs/REQUIREMENTS.md` → `ARCHITECTURE.md` → `DESIGN.md`. Code carries `@design` tags and tests carry `@verifies` tags; `pnpm trace` (inside `pnpm check`) fails on untagged or orphaned items. A new `DESIGN.md` Code list may only name files in trace scope (not CSS). Keel's `locked` check rejects edits to existing tests, so add new test files.

## Gotchas

- Tests that spawn git must strip `GIT_*` env; run tsx via `node node_modules/tsx/dist/cli.mjs`, not `pnpm exec`. Anything run via npx must use relative imports, not `@/`.
- Under heavy host load (`uptime` > 100), photo-folder integration and `tests/pipeline/run.test.ts` time out; they pass idle and in CI.
- After pulling main, run `pnpm install --frozen-lockfile` before `pnpm release:*`.
- Pre-push runs `scripts/smart-test-strategy.sh`, gitleaks and `pnpm audit --audit-level=high --prod`; never bypass.
- Verify a release by cold-installing the published version and loading `/studio`.

## Publishing

Uses GitHub OIDC trusted publishing — do NOT run `npm publish` manually, and
never push a version-bump commit or tag directly to `main` (it's a protected
branch).

1. From an up-to-date, clean local `main`: `pnpm release:patch` (or
   `:minor`/`:major`). This bumps the version on a `chore/release-vX.Y.Z`
   branch and opens a PR — it does not touch `main` directly.
2. Get that PR reviewed and merged (`keel gate`, an independent review, then a
   squash merge after green CI, which is fine — the tag is created from `main`'s HEAD after
   merge, not carried over from the branch, so it doesn't matter which
   merge strategy was used).
3. `git checkout main && git pull`, then `pnpm release:tag`. This creates
   and pushes the version tag from the merged `main` commit, which triggers
   `release.yml` to publish to npm (no local token or OTP needed).

## Known limits

- `app/globals.css` (a hand-layered stylesheet) fails stylelint's `no-duplicate-selectors` and `no-descending-specificity`, and the
  pre-commit hook lints any CSS file you touch. Put new styles inline or in a new, lint-clean file; do not reorder the legacy file without
  screenshot checks of every Studio state.
