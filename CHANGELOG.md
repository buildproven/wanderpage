# Changelog

## 0.4.0 — 2026-10-03

- **Easier first run.** Node.js is now the only prerequisite: pnpm is no longer needed. The launcher shows three numbered steps, explains an
  unsupported Node.js version in plain words, and installs a light local edition (about 130 packages / 430 MB instead of about 1,070 / 870 MB).
  Developer tooling and the hosted service are no longer installed for people who just want to make a trip page.
- Project commands are now `npm run …` (for example `npm run trip -- --input …`); contributors working from a clone still use pnpm.
- Running without an OpenAI key no longer blocks the double-click launcher; it starts and says it will make a basic edit.
- Static export and Studio no longer need a package manager on PATH.

## 0.3.3 — 2026-10-03

- **Fix (important):** a fresh `npx @buildproven/wanderpage` project showed "Not found" at `/studio` in 0.3.0–0.3.2, because the launcher built the
  hosted app instead of the static interface. Studio now builds the right thing, and a test starts the packed package with no prior build and
  loads the page. If you installed an earlier 0.3.x, upgrade by re-running `npx @buildproven/wanderpage@latest`.

## 0.3.2 — 2026-10-03

- Upgrade `workflow` to 4.8.12 and `@workflow/next` to 4.1.16: removes the deprecation warning every install printed (a queue-transport bug in the
  hosted pipeline's runtime, which the local tool does not use).

## 0.3.1 — 2026-10-03

- **Fix:** `npx @buildproven/wanderpage draft:list` (and the other agent commands) failed in 0.3.0 with `Cannot find package '@/lib'`, because tsx does
  not apply tsconfig path aliases to files under `node_modules`. The agent CLI now uses relative imports, and a test runs the packed package from a
  `node_modules` layout. Studio and project scaffolding were not affected.

## 0.3.0 — 2026-10-03

- **Honest basic edit.** Without an `OPENAI_API_KEY` a run is now labeled a basic edit in Studio, on the command line, and in the report.
- **Privacy fix.** In `hidden` and `broad` location modes a photo's raw vision caption could be published as a fallback caption and name a
  place. It is now used only in `approximate` and `precise` modes.
- **Location privacy.** Studio and `pnpm trip --privacy` now offer `hidden`, `broad`, `approximate`, and `precise`. The old `exact` label (which
  rounded to about 1 km) is renamed `precise`.
- **Installed agent commands work.** `npx @buildproven/wanderpage draft:list` (and the other `wanderpage/v1` commands) previously failed with
  "tsx not found" outside a project. They now run from any directory without pnpm and keep their documented exit codes.
- **Supply chain.** All `latest` dependency ranges are pinned to caret ranges, `tsx` is a runtime dependency, an unused `@workflow/nest`
  branch with an unpatched advisory is removed, and vulnerable transitive packages are overridden. Three network-fetched `npx …@latest`
  scripts are removed.
- **Since 0.2.0 (not yet released to npm).** Agent-ready local CLI (`wanderpage/v1`), a simpler private launch, and the preview-gated hosted
  creator with its private draft desk, retention, takedown, and acceptance harness.
- **V-model documentation and gate.** New `docs/REQUIREMENTS.md`, `ARCHITECTURE.md`, `DESIGN.md`, a generated `TRACEABILITY.md`, and a
  `pnpm trace` check that keeps needs, requirements, architecture, design, code, and tests aligned. The test suite roughly doubled.

## 0.2.0 — 2026-08-05

- Local launcher (`npx @buildproven/wanderpage`), Studio, deterministic demo, and the photo-folder pipeline.

## 0.1.1, 0.1.0 — 2026-07-27

- First public releases.
