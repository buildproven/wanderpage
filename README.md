# Wanderpage

Wanderpage is a local-first vacation story generator: point it at a photo folder and it builds a private, static, cinematic travel story. Originals are never modified. Published images are resized WebP files with metadata removed; public route coordinates are rounded; low-confidence locations are omitted or broadened; people are never identified.

## Setup

Requirements: Node.js 20.9+, pnpm, and macOS `sips` for HEIC fallback when Sharp/libvips cannot decode a file.

```bash
pnpm install
cp .env.example .env.local
```

Set `OPENAI_API_KEY` for real vision analysis and narrative generation. The model names and Wikimedia user agent are configurable in `.env.example`. Vercel may use an existing CLI login or `VERCEL_TOKEN`.

## Open the local app

On macOS, double-click `Open Wanderpage.command`. Or launch the same local interface from a terminal:

```bash
pnpm studio
```

Wanderpage builds the interface, opens it in the default browser, and listens only on `127.0.0.1`. Choose a photo folder, set the people and route privacy controls, and select **Build my Wanderpage**. The app shows live progress, the selected edit, rejected-photo counts, the local decision report, and the finished trip. Only one trip runs at a time.

The permanent sample stays at `/demo`. Generated trips receive readable title-based pages such as `/trips/oregon-coast`; separate titles are preserved as separate pages under `data/trips/`.

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

`pnpm test` includes a fixture-driven integration test that creates a temporary nested photo folder with JPEG, WebP, duplicate, EXIF/GPS, and (on macOS) HEIC inputs. It runs the production pipeline, builds an isolated static Next.js export, applies the privacy and 90 MB budget checks, then opens the generated story in Chromium. Temporary originals and outputs are removed after the run.

The external OpenAI path is an explicit paid/network smoke test rather than part of every local test run:

```bash
OPENAI_API_KEY=... pnpm test:live
```

It sends a small contact sheet through the configured vision model using Structured Outputs, generates the narrative, and validates the resulting manifest. Wikipedia/Wikimedia and weather remain graceful network enrichments; deterministic test substitutes cover their pipeline contracts during the default integration test.

## Environment

- `OPENAI_API_KEY`: required for real AI-backed generation and strict people exclusion.
- `OPENAI_VISION_MODEL`: defaults to `gpt-5.6-luna`.
- `OPENAI_WRITER_MODEL`: defaults to `gpt-5.6-terra`.
- `WIKIMEDIA_USER_AGENT`: descriptive API user agent.
- `WANDERPAGE_PORT`: optional local Studio port; defaults to `4317` on `127.0.0.1`.
- `VERCEL_TOKEN`: optional when the Vercel CLI is already authenticated.
- `WANDERPAGE_WORKSPACE`: optional advanced override for writing generated data, cache, reports, and public assets into an isolated workspace; the integration suite uses this to protect the repository checkout.

Online enrichment uses Wikipedia/Wikimedia and Open-Meteo during generation only. Their failure degrades to a complete photo-led story without unsupported facts; the exported site makes no runtime API calls.
