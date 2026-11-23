# Changelog

## 1.3.0 — 2026-11-23

- **Wanderpage works in Claude on the web, desktop and phone.** The Claude plugin now connects to the hosted Wanderpage server, so you can
  make a trip page from any Claude chat, not only on your Mac. Install it from Customize > Plugins, then select **Connect** and sign in with
  GitHub. Each hosted Wanderpage serves one owner.
- **Add photos from your phone or computer.** Ask Claude to add photos to a story: it gives you a one-time link (it works once and expires
  after 15 minutes). Open it, select **Continue**, and pick your photos. Then ask Claude to make the draft.
- **Privacy policy.** The hosted server's privacy policy is at https://wanderpage.buildproven.ai/privacy: what it stores, for how long,
  which cookies it sets, and how to delete your stories.
- The local version (`npx @buildproven/wanderpage`, the Claude Desktop extension) still works offline on your Mac, and your photos never leave it.
- Releases no longer run the full test suite again on your computer; they check that main passed CI.

## 1.2.0 — 2026-11-21

- **Make trip pages from a chat with Claude.** Claude can now inspect a photo folder, create a private draft, preview it, edit it, and publish
  it for you. The tools run on your Mac from your Wanderpage project folder, so your photos never leave it. They work in Claude Code and
  Claude Desktop (chat on the web and in the mobile apps cannot reach them). See "Use Wanderpage in Claude" in the README.
  - **Claude plugin (Claude Code):** `/plugin install wanderpage --marketplace buildproven/claude-plugins`, then choose your project folder.
  - **Claude Desktop extension:** download `wanderpage.mcpb` from this GitHub release, open it in Claude Desktop, select **Install**, and
    choose your project folder.
  - **Skill:** download the skill ZIP (`wanderpage-skill.zip`) from this GitHub release and upload it at Customize > Skills, so Claude knows
    the workflow and the privacy rules.
  - An OpenAI API key stays optional; without one you get the basic edit.
- **Update your project folder.** A folder set up by 1.1.0 or earlier has no Claude tools (`mcp/server.ts`). Run
  `npx @buildproven/wanderpage@latest` again where you first ran it: an older Wanderpage folder is now updated in place, and your trips and
  `.env.local` are kept. Or set up a new folder with `npx @buildproven/wanderpage@latest ~/wanderpage-claude` and choose that one.
- Publishing from Claude shows build progress, and the shareable site folder no longer contains Studio pages or the demo trip.
- A one-line installer (`install.sh`, see the README) sets up Node.js when it is missing.
- Security: updated dependencies to clear newly published advisories.

## 1.1.0 — 2026-10-10

- **Shared links look right.** Your published pages now carry link-preview tags (Open Graph and Twitter), so iMessage, Slack and social apps show the
  title and description. Set `WANDERPAGE_SITE_URL` (for example `https://trips.example.com`, no path) before exporting to add the hero photo to the
  preview. Only information already public on the page is used.
- **Prints cleanly.** The story prints without navigation or the photo viewer, with every chapter and photo visible.
- **Better photo viewer.** Swipe left or right on a phone, or press play (or Space) for a slideshow that respects reduced-motion settings.
- Security: updated Next.js to clear newly published advisories.

## 1.0.0 — 2026-10-04

The first stable release. Version 1 is the local-first tool: `npx @buildproven/wanderpage` turns a folder of photos into a private trip page, with a
traced and tested specification (`docs/REQUIREMENTS.md` → architecture → design → code → tests).

- The hosted browser creator is built and tested but **not part of v1**; the site and landing page no longer mention or link to it.
- The pre-push secret scan now checks committed history instead of git-ignored local files such as `.env.local`.
- Known limits: Windows is untested; a stylesheet lint backlog in `app/globals.css` is documented in `CLAUDE.md`.

## 0.5.0 — 2026-10-03

- **Your site opens on your story.** The home page of the shareable `out/` site now shows your published story (or an index of your stories when
  you have several) instead of the Wanderpage product page, which appears only while nothing is published.
- The Studio start screen no longer overlaps two labels; the README now says how to put your site online and that Windows is untested.

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
