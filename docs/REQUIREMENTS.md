# Wanderpage requirements

This is the top of the V-model. Everything below it — [architecture](ARCHITECTURE.md), [design](DESIGN.md), code, and tests — traces back to an
identifier in this file. [`TRACEABILITY.md`](TRACEABILITY.md) is the generated matrix and `pnpm trace` (part of `pnpm check`) fails if any link
is missing. See [`V-MODEL.md`](V-MODEL.md) for the conventions.

**Product.** Wanderpage turns a folder of travel photos into a curated, private-by-default trip page that can be hosted anywhere as plain
static files. The shipped product is the local-first tool (`npx @buildproven/wanderpage`). A browser-based hosted creator exists behind an
operator-admission gate and is labeled "coming soon" until its credentialed acceptance run passes (see [`DEPLOYMENT.md`](DEPLOYMENT.md)).

**Scope boundary.** Out of scope: identifying people, payments, accounts, video, RAW files, social features, and any claim about a place that
the evidence does not support.

## Stakeholder needs

A stakeholder need states what a person who owns photos wants. Acceptance tests prove each one.

### SN-01 Make a trip page from a folder

As a traveler I point the tool at a folder of photos and get a curated, good-looking trip page without editing anything by hand.

### SN-02 Never identify people, and honor my people choice

As a traveler I decide whether people may appear. The tool never names or recognizes anyone, and when I say "exclude people" it fails
rather than guesses.

### SN-03 Protect where I was

As a traveler I never leak my exact location. Place names and map points appear only when the evidence supports them and only as precisely
as I allow.

### SN-04 Keep my originals and remove hidden data

As a traveler my original files are never changed, and nothing I publish carries camera, GPS, or file-path metadata.

### SN-05 Stay in control of what is public

As a traveler nothing is public until I say so. I can review why photos were chosen, take a page down, and delete it.

### SN-06 Start in one step

As a non-technical user I can run one command (or double-click) with no account, and I can try the product with no API key and no photos.

### SN-07 Fail honestly and degrade gracefully

As a user I get a clear, actionable message when something is wrong, and an optional online source being down never breaks my page or
invents facts.

### SN-08 Host the result anywhere

As a user the output is a fast, accessible, responsive static site I can give to anyone or host on any static host.

### SN-09 Let tools and agents drive it safely

As a power user or an AI agent I can script the local workflow through a stable, machine-readable contract that cannot escape my
workspace or publish by accident.

### SN-10 Create from a browser without installing (preview)

As a visitor I can upload photos in a browser, close the tab, and return to a private draft, with short retention, explicit consent, and
an operator takedown. This is preview-gated until its acceptance run passes.

### SN-11 Trust the software supply chain

As an adopter I can install a reproducible, vulnerability-free, provenance-published package and read how every requirement is verified.

## System requirements

Each requirement is a single verifiable "shall". A requirement is verified by at least one **system** test (end-to-end, integration of the
whole pipeline, or a documented acceptance procedure).

### REQ-ING-01 Discover supported photos

The system shall recursively discover JPEG, PNG, WebP, HEIC, and HEIF files in the chosen folder and ignore all other files.

- **Needs:** SN-01

### REQ-ING-02 Preserve originals

The system shall not modify, move, or delete any original photo; all derived data shall be written to separate cache and output locations.

- **Needs:** SN-04

### REQ-ING-03 Read capture data locally

The system shall read capture time and GPS from each photo on the user's machine only, decode HEIC through a platform fallback when the
image library cannot, and skip an unreadable file with a visible message instead of aborting the run.

- **Needs:** SN-01, SN-07

### REQ-ING-04 Score technical quality

The system shall score each photo for sharpness, exposure, contrast, color, resolution, noise, and clipping, and reject frames that are
below 640×480 or nearly empty or severely exposed.

- **Needs:** SN-01

### REQ-ING-05 Detect duplicates

The system shall mark byte-identical photos as exact duplicates and group visually near-identical photos into clusters.

- **Needs:** SN-01

### REQ-SEL-01 Curate an editorial selection

The system shall select a chronologically ordered set of the strongest photos that is never larger than the input or the configured
maximum (12–60), with at most one photo per near-duplicate cluster, and shall choose a hero photo.

- **Needs:** SN-01

### REQ-SEL-02 Fail closed on people exclusion

When the user chooses to exclude people, the system shall reject every photo containing a visible person and shall fail the run, rather
than publish, if people analysis is unavailable or incomplete for any photo.

- **Needs:** SN-02

### REQ-SEL-03 Explain every decision

The system shall record a human-readable reason for every selected and every rejected photo and make it available in the local report.

- **Needs:** SN-05, SN-07

### REQ-AI-01 Require complete structured analysis

The system shall obtain exactly one validated analysis per photo from the vision model using structured outputs and shall reject an
incomplete, duplicated, or unexpected response.

- **Needs:** SN-02, SN-07

### REQ-AI-02 Retry only transient provider failures

The system shall retry rate limits and transient server errors up to three attempts and shall not retry deterministic client errors.

- **Needs:** SN-07

### REQ-AI-03 Never identify people

The system shall instruct the model never to identify a person or infer identity, relationship, or sensitive traits, and shall not ask for
or store any such attribute.

- **Needs:** SN-02

### REQ-AI-04 Work offline with a deterministic provider

The system shall provide a deterministic, offline demo that produces a complete page without an API key and without private photos.

- **Needs:** SN-06

### REQ-AI-05 Disclose the basic edit

When no API key is configured, the system shall run a clearly labeled basic edit (technical-quality curation, generic captions, no people
detection), shall say so in Studio, on the command line, and in the report, and shall refuse strict people exclusion.

- **Needs:** SN-06, SN-07, SN-02

### REQ-LOC-01 Name a place only with evidence

The system shall name a destination only when a sourced place exists within 500 m of the photo cluster, and otherwise shall omit the
specific place name and keep a generic region label.

- **Needs:** SN-03

### REQ-LOC-02 Never publish raw coordinates

The system shall publish coordinates only after rounding (approximate ≈ 11 km, precise ≈ 1 km) and shall never publish the raw GPS reading.

- **Needs:** SN-03, SN-04

### REQ-LOC-03 Honor the location privacy mode

The system shall support `hidden` (no place or route), `broad` (region labels, no coordinates), `approximate`, and `precise`, and shall
withhold location-bearing narrative and clues in `hidden` and `broad` modes.

- **Needs:** SN-03

### REQ-LOC-04 Enrich with sources and degrade gracefully

The system shall add destination context only from cited public sources and shall complete a photo-led page when an enrichment source is
unavailable.

- **Needs:** SN-03, SN-07

### REQ-PUB-01 Publish a validated manifest

The system shall describe every trip in a versioned manifest and shall refuse to publish a manifest that fails schema validation or
references a missing asset.

- **Needs:** SN-01, SN-07

### REQ-PUB-02 Publish metadata-free responsive images

The system shall publish only resized WebP derivatives (large, medium, thumbnail) with no embedded EXIF, XMP, or IPTC metadata.

- **Needs:** SN-04, SN-08

### REQ-PUB-03 Private by default, explicit publication

The system shall create every new trip as an unpublished private draft, keep its images out of the static site until published, and allow
the user to unpublish or delete it.

- **Needs:** SN-05

### REQ-PUB-04 Validate the exported artifact

The system shall scan the exact static artifact before release and fail if it contains image metadata, a local file path, a cache or
report path, or a configured secret.

- **Needs:** SN-03, SN-04

### REQ-PUB-05 Allocate readable unique page names

The system shall give each trip a readable, URL-safe page name derived from its title and shall never overwrite a different trip.

- **Needs:** SN-05, SN-08

### REQ-PUB-06 Replace the static export atomically

The system shall replace the exported site atomically and recover a complete previous export after an interruption.

- **Needs:** SN-07, SN-08

### REQ-PUB-07 Report size and decisions

The system shall write a local report of decisions and shall report the published image size against a budget.

- **Needs:** SN-05, SN-08

### REQ-UI-01 Studio is local only

The local Studio shall listen only on 127.0.0.1, serve only its own interface and project output, and reject requests from untrusted origins.

- **Needs:** SN-03, SN-06

### REQ-UI-02 Studio shows progress and runs one job

Studio shall show live stage progress, shall run only one trip at a time, and shall return the result, the selection, and rejected counts.

- **Needs:** SN-01, SN-05, SN-07

### REQ-UI-03 Studio reviews and publishes drafts

Studio shall list local drafts, let the user edit a draft's text, and publish, unpublish, or delete it explicitly.

- **Needs:** SN-05

### REQ-UI-04 Keep the API key private

The system shall read the API key from the shell or a private env file, shall not override a shell value with a blank placeholder, and
shall never print or store the key in output.

- **Needs:** SN-03, SN-06

### REQ-UI-05 Render an accessible responsive story

The story page shall render a complete narrative on desktop and mobile without horizontal scrolling, explain how it was made, give every
photo alternative text, and use landmark regions for assistive technology.

- **Needs:** SN-08

### REQ-UI-07 Open on the user's own story

The home page of the shareable site shall show the user's published story (or an index of their stories when there are several) and shall
show the product page only while nothing is published.

- **Needs:** SN-08, SN-01

### REQ-UI-06 Ship a permanent demo

The system shall ship a permanent `/demo` page that requires no setup.

- **Needs:** SN-06

### REQ-CLI-01 Start with one command

`npx @buildproven/wanderpage` shall set up a project folder (or reuse an existing one), install it, and open Studio, needing nothing
installed beyond Node.js and npm, show the user which of three steps it is on, and report an unsupported Node.js version in plain words with
the fix.

- **Needs:** SN-06

### REQ-CLI-06 Keep the first run light

The project the launcher installs for a user shall contain only what Studio, the pipeline, and the static export need: no test, lint,
browser-automation, or hosted-service packages, and no hosted-service source in the install.

- **Needs:** SN-06

### REQ-CLI-02 Validate command-line input

The trip command shall reject a missing or invalid people mode, photo range, or privacy mode with a clear message before doing any work.

- **Needs:** SN-07

### REQ-CLI-03 Offer a stable agent contract

The local agent CLI shall expose `wanderpage/v1` commands (`inspect`, `draft:list`, `draft:show`, `draft:validate`, `draft:publish`,
`draft:unpublish`) that write exactly one JSON result with a version, operation, and change receipt, and fixed exit codes, and shall run
from an installed package in any directory without pnpm.

- **Needs:** SN-09

### REQ-CLI-04 Confine the workspace

The agent CLI shall reject path traversal, symlinked drafts, and draft identifiers outside the slug grammar, and shall touch only approved
workspace directories.

- **Needs:** SN-09, SN-04

### REQ-CLI-05 Publish only a revalidated draft

The agent CLI shall re-run privacy validation on the draft at publish time, report the manifest and asset-tree digests of what it
published in the receipt, and never publish as a side effect of another command.

- **Needs:** SN-09, SN-05

### REQ-WEB-01 Anonymous private owner sessions

The hosted app shall give each visitor an anonymous owner session in a secure, hashed cookie and shall deny every private read to any other
session.

- **Needs:** SN-10, SN-05

### REQ-WEB-02 Explicit versioned consent

The hosted app shall refuse to create a story unless the visitor accepts the current provider and retention disclosure, and shall record
the disclosure version.

- **Needs:** SN-10, SN-03

### REQ-WEB-03 Enforce upload rules on the server

The hosted app shall enforce photo count (6–60), size (25 MiB each, 500 MiB total), and image type by byte signature on the server, using
application-owned storage paths and short-lived upload tokens.

- **Needs:** SN-10, SN-07

### REQ-WEB-04 Run durable single generation

The hosted app shall run at most one durable generation per story and per owner, shall resume a claimed run idempotently, and shall let a
failed run be retried while its sources remain.

- **Needs:** SN-10, SN-07

### REQ-WEB-05 Validate hosted output before it is a draft

The hosted app shall apply the location privacy mode and reject any output that carries raw coordinates, metadata, local paths, a secret,
or an unowned media reference.

- **Needs:** SN-10, SN-03, SN-04

### REQ-WEB-06 Publish and unpublish explicitly

The hosted app shall publish a story only on an explicit owner request for a finalized draft, shall support unpublish, and shall reject a
stale edit rather than overwrite a newer one.

- **Needs:** SN-10, SN-05

### REQ-WEB-07 Enforce retention and cleanup

The hosted app shall delete original uploads once a draft is finalized or has expired, delete abandoned drafts and expired admission
identifiers, and make deletion idempotent and retryable.

- **Needs:** SN-10, SN-04

### REQ-WEB-08 Allow operator takedown

An operator holding the separate secret shall be able to remove a public story immediately, with rate limiting and idempotent object
cleanup.

- **Needs:** SN-10, SN-05

### REQ-WEB-09 Fail closed when unconfigured or disabled

The hosted app shall return a visible configuration error, and shall not fall back to memory, local files, or mock AI in a deployed
environment, when a required service is missing or generation is disabled.

- **Needs:** SN-10, SN-07

### REQ-WEB-10 Resist abuse and cross-site requests

The hosted app shall require same-origin JSON for mutations, apply per-owner and admission-key limits without exposing the IP-derived
identifier, and send a nonce-based Content-Security-Policy.

- **Needs:** SN-10

### REQ-WEB-11 Guard preview acceptance

The hosted preview acceptance command shall run only against an operator-allowlisted preview URL, never production or localhost, and shall
require explicit consent before a spending run.

- **Needs:** SN-10, SN-11

### REQ-REL-01 Pin dependency ranges and avoid known vulnerabilities

The package shall declare no `latest` dependency range, shall ship only an allowlist of files, and shall pass a high-severity production
dependency audit.

- **Needs:** SN-11

### REQ-REL-02 Publish releases only from main by trusted publishing

A release shall be cut only from a clean, up-to-date `main` through a pull request and a tag, and published by the CI trusted-publishing
identity, never from a developer machine.

- **Needs:** SN-11

### REQ-QA-01 Keep the V-model traceable

The repository shall fail its quality gate when a need, requirement, architecture component, or design unit lacks an upward link, a
downward realization, or a verifying test, or when a source file or test file is untraced.

- **Needs:** SN-11
