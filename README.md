# Wanderpage

Wanderpage turns travel photos into a private, cinematic story. The local-first flow is ready today; the hosted browser creator is implemented behind a preview and operator-admission gate and remains labeled **coming soon** until its credentialed acceptance run is complete. Originals are never modified; generated WebP derivatives remove metadata; people are never identified.

## Hosted browser app (preview-gated)

The server-backed Next.js creator is implemented, but `/create` stays preview-gated until an isolated Vercel deployment passes the hosted acceptance sequence. To activate a preview, deploy the application to Vercel, connect a private Vercel Blob store and Neon Postgres database, and apply every SQL file in [`db/migrations`](db/migrations) in numeric order inside one deployment transaction. Then set `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `WANDERPAGE_SESSION_PEPPER`, `WANDERPAGE_ADMISSION_PEPPER`, `WANDERPAGE_GENERATION_ENABLED=true`, `WANDERPAGE_DAILY_GENERATION_LIMIT`, `CRON_SECRET`, `WANDERPAGE_OPERATOR_SECRET`, and `OPENAI_API_KEY`. Vercel Workflow is compiled through `next.config.ts` and processes durable draft jobs. Follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); provisioning services and enabling generation require explicit operator approval.

This does not require Stripe, payments, a native app, or an Apple developer account. The detailed privacy, ownership, retention, and deployment decisions are recorded in [`docs/decisions/ADR-web-story-creator.md`](docs/decisions/ADR-web-story-creator.md).

When the hosted preview is enabled, the private draft desk lets a creator return to anonymous-session drafts, watch upload and curation status, retry a failed run, edit the title and pre-processing privacy choices, and publish or revoke a story explicitly. It does not replace the credentialed preview acceptance sequence above, and generation remains disabled until that sequence passes.

The credentialed preview activation sequence and Vercel settings are documented in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Quickstart

Requirements: Node.js 24.18.0, [pnpm](https://pnpm.io/installation) (`npm install -g pnpm`), and macOS `sips` for HEIC fallback when Sharp/libvips cannot decode a file. If pnpm is missing, `npx @buildproven/wanderpage` tells you so and exits — install it and re-run the same command.

```bash
npx @buildproven/wanderpage
```

This creates a `./wanderpage` project folder, installs dependencies, and opens Studio in your browser — nothing runs anywhere but your machine. Pass a folder name to scaffold somewhere else (`npx @buildproven/wanderpage my-trips`), or re-run the same command later to relaunch Studio in an existing project.

For real vision analysis and narrative generation, Wanderpage needs your `OPENAI_API_KEY`. The easiest personal setup is to double-click `Open Wanderpage.command`: on the first run it installs dependencies, checks .env.local and .env, and if needed asks for the path to an existing env file. The key stays on your machine and is never printed or uploaded by the launcher. The model names and Wikimedia user agent are configurable in `.env.example`.

## Cloning instead

If you'd rather work from a git clone (for contributing, or to track the source directly):

```bash
git clone https://github.com/buildproven/wanderpage.git
cd wanderpage
pnpm install
cp .env.example .env.local
```

## Open the local app

On macOS, double-click `Open Wanderpage.command`. Or launch the same personal flow from a terminal:

```bash
pnpm private
```

You can point the launcher at an existing env file without copying it:

```bash
WANDERPAGE_ENV_FILE="/absolute/path/to/.env" pnpm private
```

Use `pnpm studio` when you want the lower-level launcher and already have the environment configured.

Wanderpage builds the interface, opens it in the default browser, and listens only on 127.0.0.1. Choose a photo folder, set the people and route privacy controls, and select **Build my Wanderpage**. The app shows live progress, the selected edit, rejected-photo counts, the local decision report, and the finished trip. Only one trip runs at a time.

The permanent sample stays at `/demo`. Generated trips receive readable title-based pages such as `/trips/oregon-coast`; separate titles are preserved as separate pages under `data/trips/`.

## Generate a story

```bash
pnpm trip --input "/absolute/path/to/vacation-photos" --people include --title "Oregon Coast 2026"
pnpm trip:list
pnpm trip:publish oregon-coast-2026
pnpm build
pnpm static:export
pnpm preview
```

New trips are private drafts: their images stay outside the static site until you publish them. In Studio, review the draft and use **Publish this story**. From the CLI, use `pnpm trip:list` to find the generated slug, then `pnpm trip:publish <slug>` before building. `pnpm trip:unpublish <slug>` removes a trip and its assets from the next static export.

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

Local-only reports are written under `.trip-output/`; cache artifacts live under `.trip-cache/`. Neither directory is exposed by the hosted app.

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

`pnpm build` creates the hosted server application. `pnpm static:export` creates the local-only rollback site under `out/` in an isolated build workspace that excludes hosted API routes. `pnpm privacy` validates that exact artifact. The required `pnpm test` gate rebuilds and validates both server and static modes before browser tests.

The external OpenAI path is an explicit paid/network smoke test rather than part of every local test run:

```bash
OPENAI_API_KEY=... pnpm test:live
```

It sends a small contact sheet through the configured vision model using Structured Outputs, generates the narrative, and validates the resulting manifest. Wikipedia/Wikimedia and weather remain graceful network enrichments; deterministic test substitutes cover their pipeline contracts during the default integration test.

## Environment

- `OPENAI_API_KEY`: required for real AI-backed generation and strict people exclusion.
- `DATABASE_URL`: required for hosted owner sessions, stories, and runs.
- `WANDERPAGE_ADMISSION_PEPPER`: dedicated HMAC key for short-lived abuse-control identifiers; identifiers are cleared after 24 hours.
- `WANDERPAGE_OPERATOR_SECRET`: separate bearer credential for emergency revocation through `DELETE /api/operator/stories/{storyId}`. The route immediately removes public visibility and starts idempotent object cleanup.
- `BLOB_READ_WRITE_TOKEN`: required for private direct uploads and private derivative delivery.
- `WANDERPAGE_SESSION_PEPPER`: required to hash anonymous owner-session cookies; use a long, random value.
- `OPENAI_VISION_MODEL`: defaults to `gpt-5.6-luna`.
- `OPENAI_WRITER_MODEL`: defaults to `gpt-5.6-terra`.
- `WIKIMEDIA_USER_AGENT`: descriptive API user agent.
- `WANDERPAGE_PORT`: optional local Studio port; defaults to `4317` on 127.0.0.1.
- `WANDERPAGE_ENV_FILE`: optional path to an existing private env file; the personal launcher reads it without copying it into this project.
- `VERCEL_TOKEN`: optional when the Vercel CLI is already authenticated.
- `WANDERPAGE_WORKSPACE`: optional advanced override for writing generated data, cache, reports, and public assets into an isolated workspace; the integration suite uses this to protect the repository checkout.

Online enrichment uses Wikipedia/Wikimedia and Open-Meteo during generation only. Their failure degrades to a complete photo-led story without unsupported facts; the exported site makes no runtime API calls.
