# Wanderpage

Local-first software that turns a folder of travel photos into a curated static
trip page. Preserve originals, never identify people, never publish exact GPS,
and omit unsupported location claims.

Use pnpm. Run `pnpm check` before shipping. GitHub pull requests must pass the
QA Architect workflow and `/bs:quality --merge` before reaching `main`.

## Publishing

Uses GitHub OIDC trusted publishing — do NOT run `npm publish` manually, and
never push a version-bump commit or tag directly to `main` (it's a protected
branch; see `docs/npm-release-process.md` in claude-setup for why).

1. From an up-to-date, clean local `main`: `pnpm release:patch` (or
   `:minor`/`:major`). This bumps the version on a `chore/release-vX.Y.Z`
   branch and opens a PR — it does not touch `main` directly.
2. Get that PR reviewed and merged (`/bs:quality --merge` squash-merges by
   default, which is fine — the tag is created from `main`'s HEAD after
   merge, not carried over from the branch, so it doesn't matter which
   merge strategy was used).
3. `git checkout main && git pull`, then `pnpm release:tag`. This creates
   and pushes the version tag from the merged `main` commit, which triggers
   `release.yml` to publish to npm (no local token or OTP needed).
