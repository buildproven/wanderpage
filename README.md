# Wanderpage

Turn a folder of travel photos into a private, cinematic trip page you can host anywhere as plain static files.

- **Private by default.** Nothing is public until you publish it. Your originals are never modified or uploaded.
- **No people identified. No exact GPS.** Place names and map points appear only when the evidence supports them, rounded, and only as precisely as you allow.
- **Metadata removed.** Published images are resized WebP files with no camera, GPS, or file-path data.
- **Local first.** One command on your machine. No account, server, or database.

## Quickstart

You need one thing: [Node.js](https://nodejs.org) 24 or newer (the current LTS download). Then run:

```bash
npx @buildproven/wanderpage
```

It shows three steps — set up, install (about a minute, once), start Studio (about 30 seconds the first time) — then opens **Studio** in your
browser. Choose a photo folder, pick your privacy settings, and select **Build my Wanderpage**. Review the draft, then **Publish this story**.
Your shareable site is the `out/` folder inside the project (`./wanderpage` by default).

To try it with no key and no photos, open the built-in demo at `/demo`, or run `npm run trip:demo` inside the project.

Run the same command later to reopen Studio in the existing project. Pass a folder name to put the project somewhere else
(`npx @buildproven/wanderpage my-trips`). If you made a project with 0.3.0–0.3.2, delete that folder and run the command again.

### Add your OpenAI key for the full edit

Without a key, Wanderpage makes a **basic edit**: photos are ranked by technical quality only, with generic captions and **no people detection**.
Studio, the command line, and the report all say so. For AI curation, captions, and strict people exclusion, put your key in `.env.local`:

```
OPENAI_API_KEY=sk-...
```

On a Mac you can double-click `Open Wanderpage.command` instead; it asks for the path to an existing env file if it cannot find a key. The key stays on
your machine and is never printed, stored in output, or uploaded to anything except OpenAI.

Wanderpage is tested on macOS and Linux. It should also run on Windows, but that is not tested.

## Your privacy choices

| Choice               | Options                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **People**           | **Include** (nobody is identified) or **Exclude** (every photo with a visible person is dropped; needs an OpenAI key and fails closed). |
| **Location privacy** | **No locations**, **Region only**, **Approximate** (about 11 km, the default), or **Closer** (about 1 km, `precise`).                   |

Before anything leaves your machine, Wanderpage scans the exact site it built and refuses to continue if it finds image metadata, a local file path, a
report path, or a configured secret.

## Share your page

`out/` is a complete static website, and its home page is your story (or a list of your stories). Put the folder on any static host — for example
drag it onto [Netlify Drop](https://app.netlify.com/drop), or upload it to GitHub Pages, Cloudflare Pages, or S3 — or preview it locally:

```bash
npm run preview:static     # serves out/ at http://127.0.0.1:4174
```

New trips are **private drafts**; their images stay out of the site until you publish. In Studio use **Publish this story** and **Unpublish**.
From the command line use `npm run trip:list`, then `npm run trip:publish -- <name>` or `npm run trip:unpublish -- <name>`, and
`npm run static:export` to rebuild `out/`. To put a preview online with the Vercel CLI, add `--deploy` to `npm run trip --` (it needs `vercel` installed and logged in).

## Command line

```bash
npm run trip -- --input "/path/to/photos" --people include --title "Oregon Coast 2026"
npm run trip -- --input "/path/to/photos" --people exclude --max-photos 36 --privacy broad
npm run trip -- --input "/path/to/photos" --people include --dry-run     # report only, publish nothing
```

| Option                      | Meaning                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `--people include\|exclude` | Required (except with `--demo`).                                          |
| `--privacy`                 | `hidden`, `broad`, `approximate` (default), or `precise`.                 |
| `--max-photos 12..60`       | Upper bound on photos in the story (default 36).                          |
| `--title "…"`               | Story title. Pages get readable names such as `/trips/oregon-coast-2026`. |
| `--dry-run` / `--force`     | Report without publishing / ignore cached analysis.                       |
| `--demo`                    | Rebuild the deterministic demo (no key, no photos).                       |

Supported inputs are nested JPEG, PNG, WebP, HEIC, and HEIF files. HEIC is converted with macOS `sips` when the image library cannot decode it; on other
systems an undecodable file is skipped with a message and the run continues.

Every run writes a plain-language report to `.trip-output/report/index.html` that says why each photo was kept or left out. Cache files live in
`.trip-cache/`. Neither folder is ever part of the published site.

## For scripts and AI agents

A versioned, read-mostly contract (`wanderpage/v1`) lets tools drive the local workflow. Each command prints exactly one JSON result on standard output
with `--json`.

```bash
npx @buildproven/wanderpage inspect "/path/to/photos" --json
npx @buildproven/wanderpage draft:list --json
npx @buildproven/wanderpage draft:show oregon-coast-2026 --json
npx @buildproven/wanderpage draft:validate oregon-coast-2026 --json
npx @buildproven/wanderpage draft:publish oregon-coast-2026 --json
npx @buildproven/wanderpage draft:unpublish oregon-coast-2026 --json
```

Add `--workspace /path/to/wanderpage` when running from another directory. Exit codes: `0` success, `2` invalid arguments, `3` policy or validation
failure, `4` missing target, `10` unexpected error. `inspect`, `list`, `show`, and `validate` never change anything; `publish` and `unpublish` are explicit,
re-run the privacy scan, and report the digests of what they published. Details: [`docs/decisions/ADR-agent-ready-cli.md`](docs/decisions/ADR-agent-ready-cli.md).

## Troubleshooting

| You see                                                         | Do this                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Wanderpage needs Node.js 24 or newer…`                         | Install the current LTS from nodejs.org, then re-run the same command.                             |
| "No OpenAI key found" banner in Studio                          | Add `OPENAI_API_KEY` to `.env.local` and restart, or continue with the basic edit.                 |
| `OPENAI_API_KEY is required for strict --people exclude`        | Strict exclusion needs the vision model. Add a key, or choose **Include**.                         |
| `No supported JPEG, PNG, WebP, HEIC, or HEIF photos were found` | Check the folder path; subfolders are searched automatically.                                      |
| A photo is listed as skipped                                    | It could not be decoded (corrupt, or HEIC on a non-Mac system). The rest of the run is unaffected. |
| Studio port is busy                                             | Set `WANDERPAGE_PORT` to another port.                                                             |
| `Privacy validation failed…`                                    | The message names the file and the rule. Nothing was published; fix the cause and rebuild.         |

## Configuration

Set these in `.env.local` (see `.env.example`) or your shell.

- `OPENAI_API_KEY` — enables the full edit and strict people exclusion.
- `OPENAI_VISION_MODEL`, `OPENAI_WRITER_MODEL` — model names (defaults in `.env.example`).
- `WIKIMEDIA_USER_AGENT` — descriptive user agent for the optional Wikipedia/Open-Meteo lookups. These lookups are the only other network calls; if they
  fail, the page is simply photo-led.
- `WANDERPAGE_PORT` — Studio port (default 4317, bound to 127.0.0.1 only).
- `WANDERPAGE_ENV_FILE` — path to an existing private env file to read without copying it.
- `WANDERPAGE_WORKSPACE` — advanced: write data, cache, and output somewhere other than the project folder.
- `VERCEL_TOKEN` — optional, only for `--deploy` when the Vercel CLI is not already logged in.

## Hosted browser creator (not part of v1)

A server-backed creator (anonymous private drafts, direct private uploads, durable processing, short retention, operator takedown) is built and
tested, but it is not offered in v1: running it means operating paid services for other people. You do not need it. If you want to run it yourself,
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) has the steps and [`docs/decisions/ADR-web-story-creator.md`](docs/decisions/ADR-web-story-creator.md) the design.

## How it is built and verified

Wanderpage is specified and verified as a V-model, and a script keeps the layers honest:

| Level                      | Document                                                   | Verified by                 |
| -------------------------- | ---------------------------------------------------------- | --------------------------- |
| Needs and requirements     | [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)             | Acceptance and system tests |
| Architecture               | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)             | Integration tests           |
| Detailed design and code   | [`docs/DESIGN.md`](docs/DESIGN.md)                         | Unit tests                  |
| Matrix of all of the above | [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) (generated) | `pnpm trace`                |

How the IDs, tags, and the gate work: [`docs/V-MODEL.md`](docs/V-MODEL.md).

```bash
git clone https://github.com/buildproven/wanderpage.git && cd wanderpage
pnpm install
pnpm exec playwright install chromium
pnpm check          # types, lint, traceability, unit + integration + system tests, builds, privacy scan, browser tests
```

`pnpm test:live` (needs `OPENAI_API_KEY`, costs a little) additionally exercises the real OpenAI path. Release steps for maintainers are in
[`CLAUDE.md`](CLAUDE.md); changes are listed in [`CHANGELOG.md`](CHANGELOG.md); report vulnerabilities as described in [`SECURITY.md`](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).
