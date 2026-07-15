# Wanderpage

Wanderpage is a local-first TripStory generator: point it at a vacation photo folder and it builds a private, static, cinematic travel story. Originals are never modified. Published images are resized WebP files with metadata removed; public route coordinates are rounded; low-confidence locations are omitted or broadened; people are never identified.

## Setup

Requirements: Node.js 20.9+, pnpm, and macOS `sips` for HEIC fallback when Sharp/libvips cannot decode a file.

```bash
pnpm install
cp .env.example .env.local
```

Set `OPENAI_API_KEY` for real vision analysis and narrative generation. The model names and Wikimedia user agent are configurable in `.env.example`. Vercel may use an existing CLI login or `VERCEL_TOKEN`.

## Generate a story

```bash
pnpm trip --input "/absolute/path/to/vacation-photos" --people include --title "Oregon Coast 2026"
pnpm build
pnpm preview
```

Strict people exclusion requires the vision API so the tool can conservatively filter visible people:

```bash
pnpm trip --input "/absolute/path/to/vacation-photos" --people exclude --max-photos 36 --privacy approximate
```

Supported inputs are nested JPEG/JPG, PNG, WebP, HEIC, and HEIF folders. `--max-photos` accepts 12–60. Add `--dry-run` for local reports only, `--force` to invalidate caches, and `--deploy` to build and create a Vercel preview deployment.

## Deterministic demo

No API key or private photos are needed:

```bash
pnpm trip:demo
pnpm build
pnpm preview
```

The exact static output is `out/`. Local-only reports are written under `.trip-output/`; cache artifacts live under `.trip-cache/`. Neither directory is exported.

## Quality gates

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm trip:demo
pnpm build
pnpm privacy
pnpm exec playwright install chromium
pnpm test:e2e
```

## Environment

- `OPENAI_API_KEY`: required for real AI-backed generation and strict people exclusion.
- `OPENAI_VISION_MODEL`: defaults to `gpt-5.6-luna`.
- `OPENAI_WRITER_MODEL`: defaults to `gpt-5.6-terra`.
- `WIKIMEDIA_USER_AGENT`: descriptive API user agent.
- `VERCEL_TOKEN`: optional when the Vercel CLI is already authenticated.

Online enrichment uses Wikipedia/Wikimedia and Open-Meteo during generation only. Their failure degrades to a complete photo-led story without unsupported facts; the exported site makes no runtime API calls.
