# Changelog

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
