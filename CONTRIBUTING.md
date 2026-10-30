# Contributing to Wanderpage

Thanks for helping. Wanderpage turns a folder of travel photos into a private, static trip page. Four rules shape every change: preserve the
originals, never identify people, never publish exact GPS, and omit location claims the evidence does not support.

## Set up

You need [Node.js](https://nodejs.org) 24 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install --frozen-lockfile
pnpm studio        # the local UI
pnpm trip:demo     # build the built-in demo trip
```

## Before you open a pull request

```bash
pnpm check         # typecheck, lint, traceability, and the full test suite
```

- Keep one concern per pull request, and use a `feat:`, `fix:`, `chore:`, or `docs:` commit prefix.
- Add a test for a behavior change. Requirements live in `docs/REQUIREMENTS.md`; tests carry `@verifies` tags and code carries `@design` tags,
  and `pnpm trace` fails on untagged or orphaned items. Run `pnpm trace:write` after changing them.
- Do not add features that the requirements place out of scope (interactive maps, group uploads, print books) without opening an issue first.
- Do not commit photos, `.env` files, or secrets. The pre-push hook scans for them.

## Reporting a problem

Open an issue with the version (the `version` field in your project folder's `package.json`), your OS, and the steps you took. Report security problems privately
(see [SECURITY.md](SECURITY.md)), never in a public issue.

By contributing you agree that your work is released under the [MIT License](LICENSE).
