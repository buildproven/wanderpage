# Wanderpage

Local-first software that turns a folder of travel photos into a curated static
trip page. Preserve originals, never identify people, never publish exact GPS,
and omit unsupported location claims.

Use pnpm. Run `pnpm check` before shipping. GitHub pull requests must pass the
QA Architect workflow and `/bs:quality --merge` before reaching `main`.

## Publishing

Uses GitHub OIDC trusted publishing — do NOT run `npm publish` manually. Run
`pnpm release:patch` (or `:minor`/`:major`) from an up-to-date, clean local
`main` to bump the version and push the tag; `release.yml` publishes to npm
automatically (no local token or OTP needed). The release scripts refuse to
run from any other branch or with uncommitted changes.
