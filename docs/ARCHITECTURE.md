# Wanderpage architecture

Second level of the V-model: it decomposes the [requirements](REQUIREMENTS.md) into components and interfaces. Each component is realized by
one or more [design units](DESIGN.md) and is verified by **integration** tests that exercise its interfaces with real collaborators.
Decisions with long rationale live in [`decisions/`](decisions): [`ADR-web-story-creator.md`](decisions/ADR-web-story-creator.md) and
[`ADR-agent-ready-cli.md`](decisions/ADR-agent-ready-cli.md).

## System context

```
 photos on disk ──► LOCAL TOOL (one Node process on the user's machine) ──► static site (out/) ──► any static host
                      │  CLI / Studio / Agent CLI                              ▲
                      │                                                        │ rollback / local preview
                      ├──► OpenAI (vision + writing)   optional, contact sheets only
                      └──► Wikipedia / Open-Meteo      optional, coordinates rounded, degrade silently

 browser ──► HOSTED CREATOR (Next.js on Vercel, preview-gated) ──► Neon Postgres (state) + Vercel Blob (bytes) + Workflow (jobs)
```

Principles that every component obeys:

1. **Local first.** The shipped path needs no account, server, or database. Network calls are optional and degrade to a photo-led page.
2. **One processing core.** Local and hosted runs share the selection, narrative, image, and privacy logic; only persistence differs.
3. **Fail closed on privacy.** Missing analysis, invalid manifests, metadata, or unowned media stop the run instead of publishing.
4. **Private by default.** Drafts are private; publication is a separate, explicit, reversible action.
5. **Honest degradation.** Optional sources fail soft; privacy and consent failures fail hard.

## Local processing pipeline

```
discover ► ingest ► analyze ► locate ► select ► write ► enrich ► publish ► report
 (INGEST)  (INGEST)  (VISION)  (PLACE)  (CURATE) (VISION) (PLACE) (PUBLISH) (PUBLISH)
                         └───────────── orchestrated by PIPELINE ─────────────┘
```

## Components

### ARCH-INGEST Photo ingest and technical analysis

Finds photos, hashes them, reads EXIF locally, scores quality, and groups duplicates. Reads originals read-only; writes hash-keyed
working files under a cache directory. Interface: `discoverPhotos(root)`, `ingestPhotos(paths, cache)`, `groupDuplicates(photos)`.

- **Satisfies:** REQ-ING-01, REQ-ING-02, REQ-ING-03, REQ-ING-04, REQ-ING-05

### ARCH-CURATE Editorial selection

Pure function from analyzed photos and the people policy to a selection, rejected set, hero, and a reason per photo. No I/O, so privacy
rules are exhaustively testable. Interface: `selectPhotos(photos, people, max)`.

- **Satisfies:** REQ-SEL-01, REQ-SEL-02, REQ-SEL-03

### ARCH-VISION Vision and narrative provider

Wraps the AI provider behind an `AIProvider` interface with a real OpenAI implementation and a deterministic mock. Builds contact sheets,
validates structured responses against a schema, and retries only transient failures. Interface: `analyze(sheet)`, `narrate(input)`.

- **Satisfies:** REQ-AI-01, REQ-AI-02, REQ-AI-03, REQ-AI-04, REQ-AI-05, REQ-SEL-02

### ARCH-PLACE Location inference and enrichment

Turns private GPS evidence into destinations: nearest sourced place within a distance bound, rounded public coordinates, and optional
cited facts and weather. All network calls are best effort. Interface: `inferDestinations(photos, userAgent)`, `enrichDestination(...)`.

- **Satisfies:** REQ-LOC-01, REQ-LOC-02, REQ-LOC-04

### ARCH-PIPELINE Pipeline orchestration

Sequences the stages above, reports progress, applies the location privacy mode to every location-bearing field before manifest assembly,
and chooses the deterministic provider in demo mode. Interface: `runTrip(options, dependencies)`.

- **Satisfies:** REQ-AI-04, REQ-LOC-03, REQ-SEL-03, REQ-PUB-07, REQ-ING-02

### ARCH-PUBLISH Publishing and persistence

Owns the manifest schema, metadata-free derivatives, the local draft store (`data/trips`, `.trip-assets`), publish/unpublish state, page
names, the decision report, privacy validation of the exported artifact, and atomic replacement of the static export.

- **Satisfies:** REQ-PUB-01, REQ-PUB-02, REQ-PUB-03, REQ-PUB-04, REQ-PUB-05, REQ-PUB-06, REQ-PUB-07, REQ-LOC-02

### ARCH-STUDIO Local Studio

A loopback-only HTTP server plus a React interface. Accepts a folder path, runs one pipeline job at a time, streams progress by polling,
and lets the user review, edit, publish, unpublish, and delete drafts. Loads the API key from the environment or a private file.

- **Satisfies:** REQ-UI-01, REQ-UI-02, REQ-UI-03, REQ-UI-04, REQ-AI-05

### ARCH-SITE Story renderer

The static Next.js pages that render a manifest: landing page, the permanent demo, and each published trip (the export substitutes
`assets/static-trip-page.tsx` for the hosted trip route). No runtime API calls.

- **Satisfies:** REQ-UI-05, REQ-UI-06, REQ-UI-07, REQ-PUB-02

### ARCH-CLI Launcher and command-line tools

`npx` launcher (checks Node.js, sets up a light "local edition" of the package, installs it with npm, opens Studio), the private launcher,
and the `trip` / `trip:publish` / `deploy` scripts with strict argument validation. Nothing at run time needs a package manager on PATH.

- **Satisfies:** REQ-CLI-01, REQ-CLI-02, REQ-CLI-06, REQ-UI-04

### ARCH-AGENT Agent-safe local contract

Versioned `wanderpage/v1` command surface over the same local store. Read-only commands cannot change state; publish revalidates digests;
a canonical workspace root confines every path. Interface: JSON envelope on stdout, fixed exit codes.

- **Satisfies:** REQ-CLI-03, REQ-CLI-04, REQ-CLI-05

### ARCH-WEB-EDGE Hosted request edge

The proxy (nonce CSP, owner-cookie renewal), HTTP helpers (typed errors, private cache headers), same-origin mutation guards, the
admission key, and the response DTO that hides internal identifiers.

- **Satisfies:** REQ-WEB-01, REQ-WEB-09, REQ-WEB-10

### ARCH-WEB-UPLOAD Hosted upload admission

Reserves owner-scoped private object paths, issues short-lived client-upload tokens, verifies uploaded bytes by signature and size, and
enforces count and byte ceilings.

- **Satisfies:** REQ-WEB-03

### ARCH-WEB-STORY Hosted story service

The authoritative application service: create a story with consent, authorize every read by owner session, queue one run, save drafts with
optimistic concurrency, retry failed runs, publish and unpublish.

- **Satisfies:** REQ-WEB-01, REQ-WEB-02, REQ-WEB-04, REQ-WEB-06, REQ-WEB-09

### ARCH-WEB-STORE Hosted persistence

`StoryRepository` interface with a Neon Postgres implementation (transactional claims, leases, tombstones, migrations in `db/`) and an
in-memory implementation used only by tests.

- **Satisfies:** REQ-WEB-01, REQ-WEB-04, REQ-WEB-07

### ARCH-WEB-PROCESS Hosted durable processing

A Vercel Workflow that runs the shared pipeline over uploaded objects, validates the hosted output against the privacy mode, writes
private derivatives, and records typed failures.

- **Satisfies:** REQ-WEB-04, REQ-WEB-05

### ARCH-WEB-LIFECYCLE Hosted retention, cleanup, and takedown

Scheduled cleanup of sources, abandoned drafts, derivatives, and admission identifiers, plus the operator takedown route with its own
secret and rate limit.

- **Satisfies:** REQ-WEB-07, REQ-WEB-08

### ARCH-WEB-DELIVERY Hosted media and published pages

Private media delivery that re-derives and verifies the storage path, and published-story loading that fails closed when storage is
absent.

- **Satisfies:** REQ-WEB-05, REQ-WEB-06, REQ-WEB-09

### ARCH-WEB-UI Hosted creator interface

The `/create` page, the private draft desk, and publish controls. Labeled "coming soon" unless the operator admits the deployment.

- **Satisfies:** REQ-WEB-02, REQ-WEB-06

### ARCH-WEB-PREVIEW Hosted preview acceptance

An operator-run command that exercises a deployed preview end to end, refusing production, localhost, and non-allowlisted hosts.

- **Satisfies:** REQ-WEB-11

### ARCH-RELEASE Release and supply chain

Release scripts (version PR, tag from merged main), the allowlisted package contents, and the CI trusted-publishing workflow.

- **Satisfies:** REQ-REL-01, REQ-REL-02

### ARCH-QA Quality gate and traceability

`pnpm check` (types, lint, trace, unit, integration, build, privacy scan, browser tests) and the V-model traceability checker.

- **Satisfies:** REQ-QA-01, REQ-REL-01

## Data and ownership

| Data                  | Location                 | Owner          | Lifetime                                    |
| --------------------- | ------------------------ | -------------- | ------------------------------------------- |
| Original photos       | user's folder            | user           | never modified                              |
| Working cache         | `.trip-cache/`           | ARCH-INGEST    | until `--force` or deletion; never exported |
| Local report          | `.trip-output/`          | ARCH-PUBLISH   | local only; never exported                  |
| Draft manifest        | `data/trips/<slug>.json` | ARCH-PUBLISH   | until deleted                               |
| Private derivatives   | `.trip-assets/<slug>/`   | ARCH-PUBLISH   | copied to `public/` only when published     |
| Static site           | `out/`                   | ARCH-PUBLISH   | replaced atomically                         |
| Hosted story and runs | Neon Postgres            | ARCH-WEB-STORE | drafts 30 days idle; tombstones 30 days     |
| Hosted bytes          | private Vercel Blob      | ARCH-WEB-*     | sources deleted on finalize/expiry          |

## Quality attributes

- **Privacy:** enforced at three layers — selection (people), pipeline (location mode), publication (artifact scan) — each independently
  tested.
- **Reliability:** every stage degrades or fails visibly; the static export swap is atomic; hosted runs are idempotent and resumable.
- **Security:** loopback binding and origin checks locally; owner-session hashing, same-origin JSON, nonce CSP, and fail-closed
  configuration on the hosted path; reviewed ADRs.
- **Usability:** one command to start; demo with no key; plain-language errors.
- **Portability:** Node 24, pnpm; macOS `sips` is only a HEIC fallback; output is plain static files.
- **Maintainability:** pinned dependency ranges, enforced traceability, one concern per module.
