# Wanderpage detailed design

Third level of the V-model: each design unit specifies the behavior, data, and algorithm of a small group of source files that realize an
[architecture component](ARCHITECTURE.md). A unit's **Code** field is authoritative: every listed file carries a matching `@design` tag and
every source file belongs to exactly one unit. **Unit** tests verify each unit's rules; `pnpm trace` enforces all of this.

## Photo ingest and analysis

### DES-PHOTO-INGEST Discover, hash, and read photos

`discoverPhotos` walks the folder recursively and returns a sorted list of files whose extension is `.jpg .jpeg .png .webp .heic .heif`.
`ingestPhotos` processes four files at a time. For each file it computes a SHA-256, derives the id `u-<12 hex>`, and reuses a cached record
(`<hash>-photo-v1.json`) unless `force` is set. Otherwise it decodes the file (macOS `sips` converts HEIC/HEIF when the image library
cannot), writes a 512 px JPEG analysis copy to the cache, reads capture time, camera model, and GPS with `exifr` from the original
read-only, scores quality, computes the perceptual hash, and records rejection reasons for frames under 640×480 or with exposure < 12. A
file that cannot be read is skipped and reported through `onProgress`; the run continues. Originals are only ever opened for reading.
`types.ts` defines `PhotoRecord`.

- **Realizes:** ARCH-INGEST
- **Code:** lib/photos/ingest.ts, lib/photos/types.ts

### DES-PHOTO-SCORE Technical quality and perceptual hash

`technicalScores` downsamples to 128 px and computes luminance, saturation, a Laplacian sharpness estimate, contrast (luminance deviation),
exposure (distance of mean luminance from 128), clipping, resolution, and noise, each clamped to 0–100, then a weighted `overall`
(sharpness .25, exposure .20, contrast .15, resolution .15, color .10, clipping .10, noise .05). `perceptualHash` is a 64-bit difference
hash of a 9×8 grayscale thumbnail; `hammingDistance` counts differing bits.

- **Realizes:** ARCH-INGEST
- **Code:** lib/photos/scoring.ts

### DES-PHOTO-DUP Exact and near duplicates

`groupDuplicates` marks any later photo with a SHA-256 already seen as `duplicateOf` the first with the reason "Exact duplicate". For the
rest it compares perceptual hashes pairwise and assigns a shared `cluster-N` id when the Hamming distance is ≤ 7.

- **Realizes:** ARCH-INGEST
- **Code:** lib/photos/duplicates.ts

## Curation

### DES-SELECT-EDIT Editorial selection

`targetCount = min(input, max(18, min(maxPhotos, round(input × 0.12))))`. `selectPhotos` drops photos that already have rejection reasons;
in `exclude` mode it also drops any photo with `containsPeople` and drops every photo lacking semantic analysis ("People-safety analysis is
unavailable"). Eligible photos are ranked by a weighted score (technical .30, aesthetic .30, story .20, uniqueness .10, landmark or
emotional value .10; technical only without analysis), taken best first up to the target while skipping a photo whose similarity cluster is
already represented, and finally ordered by capture time. Every photo gets a reason string. The hero is the top-scoring selected photo; if
nothing remains it throws "No publishable photos remain…".

- **Realizes:** ARCH-CURATE
- **Code:** lib/selection/select.ts

## Vision and narrative

### DES-VISION-SHEET Contact sheets and analysis schema

`buildContactSheet` composes up to sixteen labeled thumbnails into one 4×4 JPEG so one model call covers many photos. `ContactSheetAnalysisSchema`
(Zod) defines the per-photo semantic record (category, aesthetic/story/uniqueness/landmark/emotional scores, `containsPeople`, caption
seed, possible locations). `requireCompleteContactSheetAnalysis` throws unless the response has exactly one entry per supplied id — no
missing, duplicate, or unexpected ids.

- **Realizes:** ARCH-VISION
- **Code:** lib/ai/contact-sheet.ts, lib/schemas/analysis.ts

### DES-VISION-PROVIDER AI providers and retry policy

`AIProvider` exposes `analyze` and `narrate`. `OpenAIProvider` calls the configured vision and writer models with Structured Outputs and a
system prompt that forbids identifying people or inferring identity, relationships, or sensitive traits. `MockAIProvider` returns
deterministic output for the demo and offline tests. `retry` makes up to three attempts and retries only rate limits (429) and 5xx/network
errors; any other client error is thrown immediately.

- **Realizes:** ARCH-VISION
- **Code:** lib/ai/provider.ts

## Place

### DES-PLACE-INFER Destination inference and coordinate rounding

`inferDestinations` groups GPS-bearing photos that lie within 25 km of a cluster's first photo, averages each cluster, and queries
Wikipedia geosearch with a descriptive user agent. It accepts the nearest entity only within 500 m (confidence 0.82 + 0.02 per photo, at
most 0.98); otherwise the destination is the generic `Region N` with confidence 0.5. `roundedCoordinate` rounds to one
decimal (approximate, ≈ 11 km) or two decimals (precise, ≈ 1 km). Raw GPS stays on the `PhotoRecord` and is never copied to a manifest.

- **Realizes:** ARCH-PLACE
- **Code:** lib/location/infer.ts

### DES-PLACE-ENRICH Sourced enrichment

`enrichDestination` returns an intentionally unlabeled introduction below confidence 0.55 and uses "the surrounding region" instead of the
name below 0.8. Otherwise it fetches the Wikipedia summary (first sentence as introduction, next two as facts, each with a `sourceId` and a
cited source) and an optional Open-Meteo historical temperature range. Any HTTP or parse failure resolves to an introduction that says
external context was unavailable, so the page remains photo-led.

- **Realizes:** ARCH-PLACE
- **Code:** lib/enrichment/providers.ts

## Pipeline

### DES-PIPE-RUN Pipeline orchestration

`runTrip` runs discover → ingest → analyze → locate → select → write → enrich → publish → report → complete, emitting `onProgress` with a
stage, a percentage, and a message. Demo mode copies and validates the bundled demo manifest and assets. Strict people exclusion without a
key throws before any work. Without a key a real run uses the deterministic provider as a **basic edit**: it announces this through
`onProgress` and the console and records `provider: "deterministic-mock"` in the run summary and report. The location privacy mode is applied while the
manifest is assembled: `hidden` removes destinations, route, captions, categories, and clues; `broad` keeps region-level names without
coordinates or evidence; `approximate` and `precise` publish rounded coordinates. A photo's vision caption seed (which can name a place) is used as a caption fallback only in `approximate` and `precise` modes. The
manifest is validated by the shared schema before anything is written.

- **Realizes:** ARCH-PIPELINE
- **Code:** lib/pipeline/run.ts

## Publishing

### DES-PUB-SCHEMA Trip manifest schema

`TripManifestSchema` (Zod, `schemaVersion: "1.0"`) is the single contract between the pipeline, local store, hosted store, and renderer. It
carries title, narrative, theme, destinations with optional rounded coordinates, route, chapters, photos (three sources and alt text),
cited sources, and the `published` flag (default `true` for legacy manifests).

- **Realizes:** ARCH-PUBLISH
- **Code:** lib/schemas/trip.ts

### DES-PUB-IMAGES Metadata-free responsive derivatives

`publishPhoto` auto-rotates the working image and writes three WebP derivatives (1800, 900, 420 px, quality 80/78/76) plus a 24 px blur
placeholder. `sharp` drops metadata by default, so none of EXIF, XMP, or IPTC is written. `outputBytes` sums file sizes for the budget.

- **Realizes:** ARCH-PUBLISH
- **Code:** lib/publishing/images.ts

### DES-PUB-PRIVACY Static artifact privacy scan

`validateStaticExport` walks the artifact. Every image must have no EXIF/XMP/IPTC; every text file (`html js json txt css xml`) must not
match a forbidden pattern (a `/Users/` or `\Users\` path, `.trip-output`, `.trip-cache`, `OPENAI_API_KEY=`, `VERCEL_TOKEN=`) or contain a
configured secret. `privacy-check.ts` runs it against `out/` and exits non-zero with every finding.

- **Realizes:** ARCH-PUBLISH
- **Code:** lib/publishing/privacy.ts, scripts/privacy-check.ts

### DES-PUB-REPORT Local decision report

`writeReports` writes `photo-analysis.json` (hash, size, capture time, camera, scores, duplicate cluster — never file paths or GPS),
`location-analysis.json`, `selection.json` (selected ids, rejected reasons), `run-summary.json`, and `report/index.html` under
`.trip-output/`. The report is local only and is excluded from the export by `DES-PUB-PRIVACY`.

- **Realizes:** ARCH-PUBLISH
- **Code:** lib/publishing/report.ts

### DES-PUB-STORE Local draft store and publication state

`writeTrip`, `getTrip`, `listTrips`, `deleteTrip`, and `setTripPublished` read and write `data/trips/<slug>.json` through the schema.
`setTripPublished` flips only the `published` flag. `syncPublishedAssets` builds `public/trip/generated` from the private `.trip-assets`
of published trips only, in a fresh directory that replaces the old one by rename with rollback, and fails if a published trip lacks its
assets. `removeTripAssets` deletes one trip's private assets.

- **Realizes:** ARCH-PUBLISH
- **Code:** lib/trips/publish.ts, lib/trips/assets.ts

### DES-PUB-SLUG Readable unique page names

`tripSlug` normalizes the title (NFKD, strip accents, lowercase, hyphenate, ≤ 72 chars, fallback `untitled-trip`). `availableTripSlug`
tries the base name, then base-year, then base-2…99, and accepts a candidate only if it is free or already holds the same trip (same title,
dates, and photo ids), so a re-run updates its page and a different trip gets a different page.

- **Realizes:** ARCH-PUBLISH
- **Code:** lib/trips/slug.ts

### DES-PUB-EXPORT Atomic static export

`static-export.ts` builds the static site in an isolated workspace that excludes hosted routes and hosted-only components, then `replaceStaticOutput` swaps it
into `out/` by renaming the previous artifact aside and restoring it on failure. `recoverStaticOutput` restores a preserved artifact if an
interruption left `out/` absent and removes swap residue. `runStaticExport` runs that script with the project's own `tsx` through `node`, so no
package manager has to be on PATH.

- **Realizes:** ARCH-PUBLISH
- **Code:** lib/static-output.ts, lib/static-export-run.ts, scripts/static-export.ts

## Studio

### DES-STUDIO-SERVER Studio HTTP server

`createStudioServer` binds 127.0.0.1 and serves `/api/status`, `/api/folders/pick`, `/api/trips`, per-trip publish/unpublish/delete and
assets, `/api/jobs` (create, poll), `/report/<slug>`, and the static project output. It rejects any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, or whose `Origin` (when present) is not the same, validates job bodies with Zod (absolute readable directory, people mode, privacy `hidden|broad|approximate|precise`, 12–60 photos), allows one
active job, keeps the last jobs in memory, and returns the selection, rejected reasons, and report link. After a job and after every
publish, unpublish, or delete it runs `runStaticExport` (the shareable site in `out/` — not the hosted build), scans `out/` with
`validateStaticExport`, and restores the previous draft and site if the build or scan fails. Static serving resolves paths
under `out/` and refuses traversal.

- **Realizes:** ARCH-STUDIO
- **Code:** lib/studio/server.ts, lib/studio/types.ts

### DES-STUDIO-ENV Environment loading

`loadStudioEnvironment` reads `.env.local` then `.env`, or the file named by `WANDERPAGE_ENV_FILE`, never overriding a real shell value but
replacing a blank placeholder. Values are never logged.

- **Realizes:** ARCH-STUDIO
- **Code:** lib/studio/environment.ts

### DES-STUDIO-UI Studio interface

`Studio` is the single-page client: folder choice, people and map-precision controls, photo budget, live progress, the selected edit with
rejected counts, the draft docket (edit, publish, unpublish, delete), and a persistent privacy footer ("No identity recognition · No exact
GPS · Originals untouched"). It surfaces a failed edit instead of hiding it.

- **Realizes:** ARCH-STUDIO
- **Code:** components/Studio.tsx, app/studio/page.tsx

## Site

### DES-SITE-STORY Story renderer

`Story` renders hero, chapters with five layouts, a gallery lightbox (keyboard: Escape/arrows, scroll lock), a route summary, sources, and a
"how it was made" section; it respects reduced motion. `assets/static-trip-page.tsx` statically generates one page per published local
manifest during export, and `/demo` renders the bundled demo with product context.

- **Realizes:** ARCH-SITE
- **Code:** components/Story.tsx, assets/static-trip-page.tsx, app/demo/page.tsx

### DES-SITE-LANDING Landing page and layout

`Landing` explains the product, links to the demo, and states the privacy promises; `layout.tsx` sets metadata and system font stacks, and
`page.tsx` renders the landing page. Hosted creation is shown as "coming soon" unless `WANDERPAGE_GENERATION_ENABLED=true`.

- **Realizes:** ARCH-SITE
- **Code:** components/Landing.tsx, app/page.tsx, app/layout.tsx

## Command line

### DES-CLI-LAUNCH Launcher

`bin/wanderpage.js` first checks the Node.js version (`nodeVersionProblem`; older than 24 prints the fix and exits 1). For the six agent
commands it runs the packaged `tsx` directly with the package's tsconfig (no project, any directory) and propagates the contract's exit
code. Otherwise it prints three numbered steps: (1) copies the package into an empty target, skipping the names in `notCopied` (build,
cache, git, CI, `pnpm-workspace.yaml`, `db`, `workflows`, `proxy.ts`, `next.config.ts`) and rewrites `package.json` with `localEdition` — runtime
dependencies minus the hosted-service packages, only `typescript` and the `@types/*` build types as dev dependencies, and only the user-facing
scripts; (2) runs `npm install --no-audit --no-fund --loglevel=error`, which ships with Node; (3) starts Studio with `node` and the project's
`tsx`, exiting cleanly on SIGINT/SIGTERM. An existing project is reused and only reinstalled if `node_modules` is missing. `.env.local` is
seeded from `.env.example`. A missing API key is announced as a basic edit. `private.ts` and `studio.ts` build the static interface, open the
browser, and listen on 127.0.0.1; the double-click macOS launcher needs only Node.

- **Realizes:** ARCH-CLI
- **Code:** bin/wanderpage.js, bin/local-edition.js, bin/local-edition.d.ts, scripts/private.ts, scripts/studio.ts

### DES-CLI-TRIP Trip and publish commands

`trip.ts` validates `--people` (required unless `--demo`), `--max-photos` (integer 12–60), and `--privacy`
(`hidden|broad|approximate|precise`, default `approximate`) before
calling `runTrip`. `trip-publish.ts` lists, publishes, and unpublishes by slug and re-syncs assets. `--deploy` runs the static export (`runStaticExport`) and `deploy.ts` creates a Vercel preview
of `out/` on explicit request.

- **Realizes:** ARCH-CLI
- **Code:** scripts/trip.ts, scripts/trip-publish.ts, scripts/deploy.ts

### DES-CLI-AGENT Agent contract

`wanderpage.ts` parses the sub-command and flags and calls `lib/automation/local.ts`, which returns `{contractVersion: "wanderpage/v1",
operation, ok, data, receipt}` or an error envelope, with exit codes 0 / 2 invalid arguments / 3 policy or validation / 4 missing target /
10 unexpected. The workspace is the canonical real path of the current or `--workspace` directory; slugs must match
`^[a-z0-9]+(?:-[a-z0-9]+)*$`; symlinked drafts are rejected. `validate` returns the SHA-256 manifest digest and asset-tree digest;
`publish` recomputes both and re-runs the privacy checks before flipping the flag; `inspect`, `list`, `show`, and `validate` never write.

- **Realizes:** ARCH-AGENT
- **Code:** lib/automation/local.ts, scripts/wanderpage.ts

## Hosted creator

### DES-WEB-HTTP Hosted HTTP helpers and request proxy

`proxy.ts` generates a per-request nonce and sends a strict Content-Security-Policy (self-only, nonce plus strict-dynamic scripts, no
frames, no objects), and renews the owner cookie on document routes. `http.ts` maps `StoryServiceError` codes to HTTP statuses, maps
missing-configuration messages to a 503 `CONFIGURATION_ERROR`, and always sends `Cache-Control: private, no-store`. `blob-response.ts`
returns the raw client-token payload the Blob SDK expects. `dto.ts` removes the IP-derived admission key from every story response.

- **Realizes:** ARCH-WEB-EDGE
- **Code:** proxy.ts, lib/web/http.ts, lib/web/blob-response.ts, lib/web/dto.ts

### DES-WEB-SESSION Owner session and request guards

The owner cookie is `httpOnly`, `sameSite=lax`, `secure` in production, and lasts 30 days; only its HMAC hash is stored.
`assertInitialRequest` requires a same-origin `Origin` and JSON content type; `assertMutationRequest` additionally requires a constant-time
match of the CSRF header to the session token. `admissionKey` HMACs the trusted client address with a dedicated pepper and refuses to run
without both. `consent.ts` defines the current disclosure version.

- **Realizes:** ARCH-WEB-EDGE
- **Code:** lib/web/session.ts, lib/consent.ts

### DES-WEB-UPLOAD Upload admission

`UploadService.reserve` checks ownership, the 6–60 photo and 25 MiB / 500 MiB ceilings from `limits.ts`, allows active uploads in only one
story per owner, and returns an application-owned path and a short-lived token request. `authorize` re-checks the path and owner. `confirm`
verifies the uploaded bytes by signature (`detectImageType`: JPEG, PNG, WebP) and size, never by declared content type, and refuses
confirmation after generation starts. The three upload routes expose these to the browser.

- **Realizes:** ARCH-WEB-UPLOAD
- **Code:** lib/web/upload-service.ts, lib/web/limits.ts, app/api/uploads/route.ts, app/api/upload-reservations/route.ts

### DES-WEB-STORY Story service and routes

`StoryService` creates sessions and stories only with the current consent versions and within per-owner and daily admission limits;
authorizes every read by owner session (reads fail once deletion starts); queues exactly one run per story after a confirmed upload,
binding the run to the admitted source set; rejects duplicates and generation when disabled (`assertGenerationOpen`); saves title edits
with a version check that rejects stale edits; retries failed runs while sources remain; and publishes only finalized drafts. Types and the
`StoryRepository` interface live in `types.ts`; `runtime.ts` builds the singleton service; the four story routes are thin adapters.

- **Realizes:** ARCH-WEB-STORY
- **Code:** lib/web/story-service.ts, lib/web/types.ts, lib/web/runtime.ts, app/api/stories/route.ts, app/api/stories/[storyId]/route.ts, app/api/stories/[storyId]/generate/route.ts, app/api/stories/[storyId]/publish/route.ts

### DES-WEB-STORE Repository implementations

`NeonStoryRepository` implements `StoryRepository` over `@neondatabase/serverless` with transactional claims, leases, tombstones,
version-checked writes, and PostgreSQL `bigint` handling; `MemoryStoryRepository` implements the same contract for tests and refuses to
be selected in production. SQL migrations in `db/migrations` are applied in numeric order.

- **Realizes:** ARCH-WEB-STORE
- **Code:** lib/web/neon-repository.ts, lib/web/memory-repository.ts

### DES-WEB-PROCESS Hosted processing

`processStory` downloads the admitted private sources, runs the shared pipeline, and `applyLocationPrivacy` enforces the hosted mode.
`validateHostedStoryOutput` rejects raw coordinates, location text in `hidden` mode, secrets, local paths, unowned media references, and
derivatives that carry EXIF. `processStoryWorkflow` claims the run (idempotently), runs the steps, validates privacy before completion,
records a typed fatal failure, deletes failed derivatives, and deletes originals only after success.

- **Realizes:** ARCH-WEB-PROCESS
- **Code:** lib/web/processor.ts, workflows/process-story.ts

### DES-WEB-CLEANUP Retention and cleanup

`cleanupExpiredSources` deletes confirmed and abandoned sources after expiry but skips sources claimed by an active run and expires stale
runs first; leases are reclaimed after a worker dies. `cleanupExpiredPrivateStories` clears admission keys after 24 hours, expires idle
drafts after 30 days, finishes deletions, and purges tombstones after 30 days. `object-cleanup.ts` deletes exact database-owned prefixes
only. The cron route is protected by `CRON_SECRET`.

- **Realizes:** ARCH-WEB-LIFECYCLE
- **Code:** lib/web/object-cleanup.ts, lib/web/source-cleanup.ts, lib/web/story-retention.ts, app/api/cron/source-cleanup/route.ts

### DES-WEB-OPERATOR Operator takedown

`assertOperatorRequest` compares the bearer token to `WANDERPAGE_OPERATOR_SECRET` in constant time. The `DELETE` route applies the shared
key rate limit (returning retry guidance), hides the story immediately, and starts idempotent object cleanup.

- **Realizes:** ARCH-WEB-LIFECYCLE
- **Code:** lib/web/operator-auth.ts, app/api/operator/stories/[storyId]/route.ts

### DES-WEB-MEDIA Media delivery and published pages

The media route recomputes the sanitized filename and rejects a mismatch before touching storage, then streams a private derivative with
private cache headers. `loadHostedPublishedStory` validates the slug and fails closed when hosted storage is unconfigured. `/s/<slug>` and the hosted
`/trips/<slug>` route render a published story.

- **Realizes:** ARCH-WEB-DELIVERY
- **Code:** lib/web/published-story.ts, app/api/media/[storyId]/[filename]/route.ts, app/s/[slug]/page.tsx, app/trips/[slug]/page.tsx

### DES-WEB-UI Hosted creator interface

`WebCreator` collects consent, title, people and location choices, and uploads files directly to Blob; `DraftControls` shows draft status,
retry, title edit, publish, and revoke; `/create` is gated by admission and otherwise shows "coming soon"; `/stories/<id>` is the private
draft desk.

- **Realizes:** ARCH-WEB-UI
- **Code:** components/WebCreator.tsx, components/DraftControls.tsx, app/create/page.tsx, app/stories/[storyId]/page.tsx

### DES-WEB-PREVIEW Preview acceptance policy

`assertPreviewUrl` accepts only an HTTPS Vercel preview host or an exact operator-allowlisted host and rejects production and localhost.
`readPreviewRunMode` requires explicit preview confirmation, exactly one mode (`smoke` or `acceptance`), and explicit generation consent
for the spending run. `hosted-preview-acceptance.ts` applies the policy before any network call.

- **Realizes:** ARCH-WEB-PREVIEW
- **Code:** lib/web/preview-policy.ts, scripts/hosted-preview-acceptance.ts

## Release and quality

### DES-REL-RELEASE Release scripts

`release-git.ts` asserts a clean, up-to-date `main`. `release-open-pr.ts` bumps the version on a `chore/release-vX.Y.Z` branch and opens a
pull request. `release-tag.ts` tags the merged `main` commit and pushes the tag, which triggers the trusted-publishing workflow.
`release-preflight.ts` checks prerequisites. No script holds an npm token.

- **Realizes:** ARCH-RELEASE
- **Code:** scripts/release-git.ts, scripts/release-open-pr.ts, scripts/release-preflight.ts, scripts/release-tag.ts

### DES-QA-TRACE Traceability checker

`trace-model.ts` parses ID headings and link fields from the three documents, parses `@design` and `@verifies` tags from source and tests,
and checks: links resolve to the right level, every item is realized one level down, every file listed by a design unit carries its tag and
vice versa, every source and test file is tagged, and every item is verified at its level. It renders `TRACEABILITY.md`. `trace.ts` is the
command (`pnpm trace`, `pnpm trace:write`).

- **Realizes:** ARCH-QA
- **Code:** scripts/trace.ts, scripts/trace-model.ts
