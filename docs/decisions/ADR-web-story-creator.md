# ADR: Web-native Wanderpage creation

## Status

Accepted. The architecture review recorded at the end of this document found
no blocking issues. Implementation may proceed in the delivery sequence below.

## Decision summary

Wanderpage will become a server-backed Next.js application on Vercel. A visitor
can create an anonymous owner session, upload photos directly into private
Vercel Blob storage, follow a durable processing run, review a private draft,
and explicitly publish or unpublish a shareable story.

Neon Postgres owns authorization and transactional story/job state. Blob owns
binary source and derivative objects. Vercel Workflow owns retryable processing.
The existing photo pipeline will be separated from filesystem persistence and
static-site building so the same processing core can write either to the local
CLI workspace or to hosted storage.

The first release does not require accounts or payments. It is a bounded public
trial with anonymous owner sessions, rate limits, fixed upload and AI budgets,
short source retention, and an operator-controlled admission switch.

## Why this decision is needed

The current product is a local static generator:

- Studio accepts an absolute local photo-folder path and binds to `127.0.0.1`.
- The pipeline writes caches, reports, trip manifests, and generated assets to
  a local workspace.
- Publishing copies assets under `public/` and runs a complete static Next.js
  build.
- `next.config.ts` uses `output: "export"`; trip routes are enumerated at build
  time from local JSON files.

That architecture cannot provide hosted uploads, private runtime drafts,
durable processing, or publish/unpublish state. The web product must replace
those outer persistence and delivery mechanisms while preserving the validated
selection, narrative, image, provenance, and privacy behavior.

## Product requirements

### Primary user journey

1. A visitor opens `/create`; the server establishes an anonymous owner
   session in a secure cookie without requiring signup.
2. The visitor selects 6–60 supported photos, sees count/size/type validation,
   chooses a title, people policy, and location privacy level, and starts an
   upload.
3. Files upload directly from the browser to private Blob storage using
   short-lived, server-authorized upload tokens. The application never proxies
   original photo bytes through a Next.js request.
4. After every authorized object is confirmed, the visitor starts generation.
   A durable run records progress through validation, analysis, selection,
   location, narrative, derivative creation, and finalization.
5. The visitor may close or reload the page and later return to the same draft
   from the same browser session. Progress and typed failures remain visible.
6. A successful run creates a private draft. The owner can review selected
   photos, rejected count/reasons, title, subtitle, chapters, captions,
   destinations, privacy summary, and the exact public preview.
7. The owner may edit supported text fields and photo inclusion/order, then
   explicitly publish. No upload or completed run is public by default.
8. Publishing creates `/s/<public-slug>`. The owner can later unpublish or
   permanently delete the story.

### Supported first-release behavior

- Inputs: JPEG/JPG, PNG, and WebP whose decoded content matches the declared
  media type. HEIC/HEIF remain supported only by the local CLI until the hosted
  runtime is proven with representative files.
- Limits: 6–60 files, 25 MiB per file, 500 MiB total per story, and no decoded
  image above 80 megapixels. These are server-enforced, not UI-only.
- One active processing run per story and at most one active run per anonymous
  owner session.
- People choices: `include` or strict `exclude`. Strict exclusion fails closed
  when vision analysis is unavailable or incomplete.
- Hosted location choices: `broad`, `approximate`, or `hidden`. The local
  pipeline's misleading `exact` label is not exposed in the web product.
- The application discloses before upload that originals are sent to
  Wanderpage's private storage and selected contact sheets are sent to OpenAI
  for analysis. Consent is explicit and versioned on the story record.
- The first release supports modern desktop and mobile browsers. Folder upload
  is a progressive enhancement; multi-file selection and drag/drop are the
  portable baseline.

### Non-goals for the first release

- Payments, subscriptions, or Stripe.
- Permanent user accounts, cross-device recovery, or collaborative editing.
- Unlimited photo libraries, videos, RAW files, or hosted HEIC/HEIF.
- Custom domains, search/discovery feeds, comments, or social networking.
- Identifying people, inferring relationships or sensitive traits, or naming a
  location without evidence.
- Guaranteed recall of content someone downloaded while a story was public.

## Runtime and repository design

### One server application, two publishing adapters

The main Next.js application becomes server-backed: remove global
`output: "export"` and use Node.js route handlers and Server Components for
authenticated drafts and dynamic public stories.

The local CLI remains supported through an explicit static-export command and
configuration. It continues to write local manifests/assets and build `out/`.
The hosted application does not rebuild or deploy Next.js for each story.

The repository will expose these deep modules:

```text
StoryService
  createStory, getOwnedStory, updateDraft, publish, unpublish, delete

UploadService
  authorizeUpload, confirmUploadSet, expireUploads

StoryProcessor
  processStory(storyId, processorRevision)

StoryRepository
  transactional story, ownership, upload, and run state

ObjectStore
  private source/derivative reads, writes, listing, and deletion
```

The web routes and local CLI call these supported interfaces. Tests exercise
the same interfaces; they do not reach through them into adapter internals.

### Processing-core refactor

The current pipeline mixes processing with local persistence. Refactor it into:

```text
Processing request
  source descriptors + title + people mode + location privacy + limits

Processing core
  decode/normalize → deduplicate → analyze → select → infer → enrich
  → narrate → produce metadata-free WebP derivatives + TripManifest

Output adapter
  local workspace | hosted object store
```

For the first hosted implementation, one durable workflow step downloads the
authorized sources into an isolated temporary directory and runs the complete
processing core. Retrying the step is safe because it writes to a staged prefix
identified by `storyId/processorRevision/runId`; finalization atomically points
the story record at the completed revision. A failed or superseded prefix is
cleanup-eligible and never readable by the product.

Static Next.js building, `public/` synchronization, and local trip JSON writes
remain responsibilities of the local output adapter only.

## Data and ownership model

### Neon Postgres is authoritative

Use the Vercel Marketplace Neon integration and `@neondatabase/serverless` with
checked-in SQL migrations. Database initialization is lazy so builds fail only
when a runtime operation actually requires missing configuration.

Minimum tables:

```text
owner_sessions
  id uuid primary key
  secret_hash bytea unique not null
  created_at, last_seen_at, expires_at, revoked_at
  terms_version, upload_consent_version

stories
  id uuid primary key
  owner_session_id references owner_sessions
  public_slug text unique
  status story_status
  title, people_mode, location_privacy
  manifest jsonb nullable
  processor_revision text
  active_run_id uuid nullable
  source_expires_at, published_at, created_at, updated_at, deleted_at
  version integer not null

story_uploads
  id uuid primary key
  story_id references stories
  blob_path text unique
  original_name text
  declared_type, detected_type, byte_size, sha256
  status upload_status
  created_at, confirmed_at, deleted_at

story_runs
  id uuid primary key
  story_id references stories
  workflow_run_id text unique
  processor_revision text
  status run_status
  stage, progress, attempts, error_code, error_message
  started_at, finished_at, updated_at
```

All ownership checks and state changes occur in Postgres transactions. Blob
paths are data references, never authorization evidence. Optimistic `version`
checks prevent lost draft edits. A unique active-run constraint or equivalent
transaction prevents duplicate generation.

### Anonymous owner session

- On first create request, generate at least 256 bits of cryptographic entropy.
- Store only a keyed hash of the secret in Postgres.
- Set the raw opaque secret in a `Secure`, `HttpOnly`, `SameSite=Lax`,
  `Path=/` cookie. Local development omits `Secure` only on localhost.
- One session owns many stories; creating another story does not replace access
  to earlier stories.
- Every private read and every mutation resolves the cookie to an unexpired,
  unrevoked owner session and verifies story ownership.
- Mutations require an allowed `Origin`, JSON content type where applicable,
  and a per-session CSRF token bound to the session. SameSite is defense in
  depth, not the sole CSRF control.
- Anonymous sessions expire after 30 days of inactivity. Original upload
  retention is independent and shorter.
- Clearing the browser cookie loses anonymous draft access. The product states
  this before upload. Account adoption is a future migration, not implied
  recovery in this release.

## Story and run state machines

### Story status

```text
uploading → queued → processing → draft ↔ published
    │          │          │          │        │
    └──────────┴──────────┴──────────┴────────┴→ deleting → deleted
                          └→ failed → queued (explicit retry)
```

- `uploading`: owner may add/remove authorized uploads.
- `queued`: upload set is immutable and a run has been durably accepted.
- `processing`: workflow owns the active revision.
- `draft`: manifest and derivatives exist but require owner authorization.
- `published`: public story and media routes may read the finalized revision.
- `failed`: retains a typed, user-safe error and permits a bounded explicit
  retry if sources have not expired.
- `deleting/deleted`: immediately denies reads; asynchronous object deletion
  finishes idempotently.

Only the service layer may transition status. Invalid transitions return a
typed conflict and never partially mutate objects or manifests.

### Durable processing

Use Vercel Workflow, pinned to the implementation-tested version. The workflow
is identified by story ID and processor revision and contains retryable steps:

1. Claim the queued story transactionally.
2. Fetch and verify the confirmed upload inventory.
3. Run isolated processing into a staged private prefix.
4. Validate the manifest and every derivative against privacy rules.
5. Atomically finalize the revision as `draft`.
6. Delete source objects after successful finalization; otherwise retain them
   until the retry/retention deadline.
7. Remove abandoned staged objects idempotently.

Transient storage/network/429/5xx failures retry with bounded exponential
backoff. Validation, unsupported media, privacy failure, authorization loss,
and budget exhaustion are fatal typed failures. Maximum three processing
attempts per story. A workflow retry never creates another billable story run
or publishes content.

Progress is persisted after each stage and polled by the owner UI. Workflow
state is execution evidence; Postgres remains product-state authority.

## Upload contract and abuse controls

The browser uses `@vercel/blob/client` direct uploads to a private store.
`POST /api/uploads` invokes `handleUpload` and:

- authenticates the anonymous owner session;
- verifies the story is owned and still `uploading`;
- issues a token valid for at most 15 minutes;
- restricts content types and 25 MiB per-object size;
- generates an application-owned random pathname under
  `sources/<storyId>/<uploadId>`;
- disallows overwrite;
- binds story, upload, owner-session, and consent version into authenticated
  token payload;
- confirms callback data against the reserved upload record.

Before queueing, the server fetches object metadata and decodes each image to
verify signature, dimensions, count, individual bytes, total bytes, and that
every reserved upload has exactly one confirmed object. Client filenames are
display metadata only and are never used as object paths.

Admission limits for the public trial:

- 3 stories created per anonymous session per rolling 24 hours;
- 1 active upload/generation per session;
- 60 authorized objects and 500 MiB reserved bytes per story;
- 3 generation starts per session per rolling 24 hours;
- an IP-based secondary limit using privacy-conscious keyed hashes and a short
  retention window;
- a global operator switch and daily generation ceiling that fail closed before
  starting chargeable processing.

Limit decisions and resets are returned in consistent rate-limit headers.
Production thresholds are configuration with tested defaults, not hard-coded
secret operational values.

## AI, location, and privacy invariants

- OpenAI credentials are server-only. The browser never supplies or receives a
  provider key.
- At most 60 photos, bounded contact-sheet dimensions, one analysis result per
  photo, one narrative generation, and three provider attempts per typed
  retryable operation.
- Record model names, processor revision, call counts, and token/usage metadata
  on the run without recording prompts containing image data or secrets.
- Never identify a person or infer identity, relationship, emotion, health,
  ethnicity, religion, politics, sexuality, or other sensitive traits.
- Strict `exclude` requires complete vision results and excludes every photo
  marked as containing a person; uncertainty fails the run visibly.
- Raw EXIF/GPS may exist only in original source objects and the isolated
  processing workspace. It is absent from derivatives, manifests, logs, error
  messages, analytics, and public HTML.
- `broad` publishes destination/region labels with no coordinates.
- `approximate` publishes coordinates rounded to one decimal place only when
  location confidence meets the existing evidence threshold.
- `hidden` publishes neither destination labels nor route coordinates.
- Unsupported or low-confidence location claims are omitted or broadened.
- Published derivatives are resized WebP images created without metadata.
- The existing static-export privacy validator is split so manifest and asset
  privacy checks can run before hosted finalization without requiring a Next.js
  build.

## Media delivery and publication

All originals and generated derivatives remain in private Blob storage for the
first release. This intentionally favors revocable access and simple authority
over the lower delivery cost of public Blob.

- Draft media route: owner session and story ownership required.
- Published media route: story must be `published` and the requested asset must
  belong to its finalized manifest revision.
- Media routes accept opaque story/asset identifiers, never caller-supplied Blob
  URLs or arbitrary paths.
- Draft responses use `private, no-store`.
- Published responses use a bounded CDN cache no longer than 10 minutes. An
  unpublish/delete immediately denies origin reads; already downloaded or
  briefly cached public material cannot be recalled and the UI says so.
- Range requests, content type, content length, nosniff, and download headers
  are controlled by the media route.

Publishing is one Postgres transaction from `draft` to `published` after
revalidating ownership, manifest revision, privacy result, and slug uniqueness.
No binary copy is needed. Unpublishing changes authority back to `draft`.

## API and page contract

All JSON responses use `{ data }` on success and
`{ error: { code, message, details? } }` on failure. Zod validates every route
boundary. Private responses use `Cache-Control: private, no-store`.

```text
POST   /api/stories                         create owned uploading story
GET    /api/stories                         list stories for owner session
GET    /api/stories/:id                     owned status/draft/progress
PATCH  /api/stories/:id                     edit draft with version precondition
DELETE /api/stories/:id                     begin idempotent deletion
POST   /api/stories/:id/generations         validate uploads and queue run
POST   /api/stories/:id/generations/retry   retry eligible failed run
POST   /api/stories/:id/publish             explicit publication
POST   /api/stories/:id/unpublish           explicit unpublication
POST   /api/uploads                         authorize/confirm direct Blob upload
GET    /api/media/:storyId/:assetId         authorized media delivery

GET    /create                              upload/create UI
GET    /stories/:id                         private owner review UI
GET    /s/:publicSlug                       public published story
```

POST mutations accept an idempotency key. Duplicate keys for the same owner and
operation return the original result. IDs are UUIDs and public slugs include a
random suffix; neither is treated as a secret.

Expected errors include `AUTH_REQUIRED`, `FORBIDDEN`, `VALIDATION_ERROR`,
`INVALID_STATE`, `UPLOAD_LIMIT`, `RATE_LIMITED`, `PROCESSING_FAILED`,
`PRIVACY_FAILED`, `NOT_FOUND`, and `CONFIGURATION_ERROR`. Internal provider,
path, object URL, stack, and secret details never enter browser error messages.

## Retention and deletion

- Original uploads are deleted immediately after a successful draft is
  finalized. For this Vercel Hobby proof of concept, failed or abandoned source
  uploads expire after 24 hours and are deleted by the daily cleanup job no
  later than 48 hours after upload. The upload consent records this temporary
  bound; a production launch restores hourly cleanup and the 24-hour maximum.
- Superseded and abandoned staged derivatives are deleted within 24 hours.
- Draft derivatives and records expire after 30 days of owner inactivity in the
  public trial; the UI shows the date.
- Published stories remain until the owner deletes them or the trial retention
  policy changes with notice. Anonymous-session expiry does not silently
  unpublish an already public story; operator support is required until account
  recovery exists.
- Delete immediately denies draft/public application reads, revokes active
  work, and starts idempotent object deletion. Database tombstones retain only
  the minimum operational audit fields for 30 days, then purge.
- Cleanup enumerates only database-owned exact object prefixes and never accepts
  a browser-supplied deletion path.

## Configuration and failure behavior

Required hosted configuration:

- `DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN` connected to a private Blob store
- `OPENAI_API_KEY`
- cryptographic session/CSRF key material
- Workflow deployment configuration
- admission and retention settings

Builds may succeed without production secrets so preview source validation can
run. `/create` and its APIs fail visibly with `CONFIGURATION_ERROR` when a
required runtime service is missing. There is no memory, local-filesystem,
public-storage, mock-AI, or static-demo fallback in a deployed production
environment.

The permanent `/demo` remains deterministic and does not require these services.

## Delivery sequence

1. Refactor privacy validation and pipeline output seams without changing local
   behavior; prove the existing CLI and static export remain green.
2. Convert the main Next.js runtime to server mode and add an explicit local
   static-export path.
3. Add Neon schema/migrations, owner-session security, repository/service
   modules, and deterministic adapter tests.
4. Add private direct uploads, confirmation, limits, and cleanup.
5. Add durable processing around the refactored pipeline with mocked provider
   integration tests and failure/retry evidence.
6. Add private review/edit UI and media authorization.
7. Add explicit publish/unpublish/delete and public story rendering.
8. Run a credentialed isolated Vercel preview with synthetic/non-sensitive
   photos, then one human-approved real-photo pilot before production enablement.

Each step is independently mergeable only when it preserves a working product
and advances the same architecture. Feature flags may hide incomplete hosted UI;
they may not weaken authorization or privacy checks.

## Verification and acceptance evidence

Implementation is ready for production trial only when all of the following are
proven at the supported public seam:

### Deterministic tests

- Existing `pnpm check`, local CLI, static export, privacy, and browser tests
  pass after the runtime split.
- Route/service tests prove owner A cannot list, read, edit, publish, unpublish,
  delete, or fetch draft media for owner B's story.
- Missing, expired, revoked, malformed, and CSRF-invalid sessions fail closed.
- Upload tests prove type/signature, count, dimensions, individual size, total
  size, token expiry, callback binding, overwrite, and duplicate confirmation.
- State-machine tests reject every invalid transition and prove idempotent
  create/generate/publish/unpublish/delete behavior.
- Workflow tests prove transient retry, fatal failure, duplicate-start
  prevention, crash/resume, superseded-run isolation, and cleanup.
- Privacy tests inspect hosted manifests, derivatives, HTML, headers, logs, and
  errors for raw GPS, EXIF/IPTC/XMP, local paths, Blob URLs, and secrets.
- `exclude` fails on missing/incomplete vision results and never publishes a
  photo classified as containing people.
- Unpublished/deleted stories and media return not found to public callers.
- Published pages load all selected images at desktop/mobile viewports with no
  console errors and meet the existing 90 MiB story budget.

### Preview verification

- Exact PR head passes repository gates, QA Architect, security audit, and
  `/bs:quality --merge` evidence requirements.
- An isolated Vercel preview uses a private Blob store, preview Neon database,
  non-production OpenAI key, and Workflow runtime.
- A synthetic 60-photo maximum-bound run completes or fails within its explicit
  limits; progress survives refresh and a forced retry.
- Direct storage inspection proves originals are private and deleted after
  success; generated derivatives contain no metadata.
- Publish, anonymous public access, unpublish, republish, delete, session loss,
  and cross-session denial are exercised in a real browser.
- Operator admission shutoff prevents new chargeable runs without disrupting
  existing public stories.

Deployment, provisioning external services, enabling production admission, and
using real private photos require Brett's separate approval. Green code and
preview evidence do not imply that authority.

## Alternatives rejected

1. **Keep Terminal/`npx` as the customer flow.** It does not meet the consumer
   usability requirement.
2. **Package a native Mac app.** It introduces platform distribution friction
   and does not satisfy the chosen web-first direction.
3. **Run the current Studio server in a Vercel Function.** Local paths, native
   folder selection, process memory, mutable workspace state, and per-story
   static builds are incompatible with the hosted product.
4. **Keep global static export and bolt on APIs.** Static export cannot provide
   runtime route handlers or dynamic private/public authority.
5. **Use Blob as the story database.** It lacks the transactional ownership,
   state-transition, concurrency, and query model required here.
6. **Use a per-story cookie secret.** It breaks multi-story ownership and makes
   later account adoption harder than an owner-session model.
7. **Proxy original uploads through the app.** It increases cost and exposes
   requests to avoidable size/duration limits; private direct upload is the
   supported path.
8. **Put derivatives in public Blob immediately.** It would make drafts public.
9. **Copy derivatives to public Blob on publish.** It improves delivery cost
   but complicates atomic publish/unpublish and revocation. Reconsider after
   measuring the private-media pilot.
10. **Process synchronously in the generation request.** It cannot reliably
    survive request termination, refresh, or retry.
11. **Require accounts before trial.** It adds conversion friction before the
    core create-review-share loop is validated. The owner-session boundary
    permits later account adoption.

## Invariants

- No story or derivative is public before explicit owner publication.
- Every private operation proves active owner-session authorization.
- Originals never enter the repository, public storage, logs, analytics, or a
  public response.
- Raw GPS and source metadata never enter a generated derivative or public
  manifest.
- People are never identified; strict exclusion fails closed.
- Postgres owns product state; Workflow owns execution; Blob owns bytes.
- Retried work is idempotent and cannot publish or overwrite a newer revision.
- Missing production configuration is visible and cannot select an insecure
  fallback.
- Local CLI behavior and original-file preservation remain supported.
- No payment system or Stripe dependency is introduced by this release.

## Rollback

The hosted create entry point is controlled by operator admission configuration.
Rollback disables new story creation and processing while leaving `/demo`, the
local CLI, and already published stories readable. Schema changes are additive
until the trial is accepted. No rollback deletes user content automatically.

## Architecture review

- Date: 2026-08-13 (America/Chicago)
- Reviewer: independent `gpt-5.6-sol`, high reasoning, read-only and ephemeral
- Reviewed artifact: staged new-file blob `4715d06`; repository base
  `9548d0bf6b774eeae3dec869fc04f03ed1469de7`
- Review contract: concrete blockers, contradictions, missing decisions,
  security/privacy failures, and non-implementable requirements only
- Findings: none
- Verdict: `CLEAN` — sufficiently complete and internally consistent to begin
  implementation; this does not claim that implementation or production
  provisioning is complete
