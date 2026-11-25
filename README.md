# Wanderpage

Turn a folder of travel photos into a private, cinematic trip page you can host anywhere as plain static files.

- **Private by default.** Nothing is public until you publish it. Your originals are never modified, and the local tools never upload them.
- **No people identified. No exact GPS.** Place names and map points appear only when the evidence supports them, rounded, and only as precisely as you allow.
- **Metadata removed.** Published images are resized WebP files with no camera, GPS, or file-path data.
- **Local first, or in chat.** Run one command on your machine with no account, server, or database, or use the claude.ai plugin, which takes photos only through a one-time upload link you open.

## Use Wanderpage in Claude

Wanderpage is made to be driven from a chat with Claude.

**Claude on the web, desktop and phone (claude.ai plugin).** Add the Wanderpage plugin to your claude.ai account at
Customize > Plugins, then select **Connect** and sign in to the hosted Wanderpage server (`https://wanderpage.buildproven.ai/api/mcp`).
Install it once; it then works in chat on the web, in Claude Desktop, in the mobile apps and in Claude Code. Ask Claude for a trip
page: it creates a private story and gives you a one-time upload link (`upload_photos`). Open the link in a browser, pick your photos,
and Claude makes the page. Stories stay private until you ask Claude to publish one. In Claude Code, install the same plugin from the
BuildProven marketplace (`buildproven/claude-plugins`):

```text
/plugin install wanderpage --marketplace buildproven/claude-plugins
```

**Offline, on your Mac.** To keep your photos on your Mac, run the Wanderpage tools locally from the Desktop extension or a Claude
Code local server. Chat on the web and in the mobile apps cannot reach a local server, so the local tools work in Claude Code and
Claude Desktop only. First run `npx @buildproven/wanderpage` once (see [Quickstart](#quickstart)) to set up your project folder (by
default, `wanderpage` in the folder where you ran `npx @buildproven/wanderpage`).
The local tools run from that folder, so it must contain `mcp/server.ts`. Versions up to 1.1.0 do not ship it, and a 1.1.0 launcher run
again does not update an existing folder. Version 1.2.0 or later ships it. If your folder has no `mcp/server.ts`, run
`npx @buildproven/wanderpage@latest` again from the same folder where you first ran it (not from inside the project folder); if you
first gave a folder path, give the same folder path again. It updates the existing folder and keeps your trips and `.env.local`. Or set up a new one with `npx @buildproven/wanderpage@latest ~/wanderpage-claude` and choose that folder, or choose a checkout of this
repository after `pnpm install`.

Then use one of these:

- **Claude Desktop extension.** Download
  [`wanderpage.mcpb`](https://github.com/buildproven/wanderpage/releases/latest/download/wanderpage.mcpb) from the latest GitHub
  release. Open it in Claude Desktop (or drag it onto Settings > Extensions), select **Install**, and choose your Wanderpage project
  folder. An OpenAI API key is optional; it enables the full edit and strict people exclusion. In a checkout of this repository,
  `pnpm install` and then `pnpm mcpb` build the same file at `dist/mcpb/wanderpage.mcpb`.
- **Skill.** Download
  [`wanderpage-skill.zip`](https://github.com/buildproven/wanderpage/releases/latest/download/wanderpage-skill.zip) from the latest
  GitHub release (in a checkout, `pnpm mcpb` also writes `dist/mcpb/wanderpage-skill.zip`). Upload that skill ZIP at Customize > Skills
  so Claude knows the workflow (inspect a folder, create a draft, preview, edit, publish) and the privacy rules. In Claude Code, the
  skill loads from `skills/wanderpage/` in this repository.
- **Claude Code.** Add the server with `claude mcp add`:

  ```bash
  claude mcp add wanderpage -e WANDERPAGE_WORKSPACE="$HOME/wanderpage" -- \
    node "$HOME/wanderpage/node_modules/tsx/dist/cli.mjs" --tsconfig "$HOME/wanderpage/tsconfig.json" "$HOME/wanderpage/mcp/server.ts"
  ```

  This example assumes you ran `npx @buildproven/wanderpage` in your home folder. If you ran it somewhere else, put your project
  folder's path in place of `$HOME/wanderpage`.

Studio is frozen: it keeps working, but new features go to the Claude tools, not to Studio.

## Quickstart

You need one thing: [Node.js](https://nodejs.org) 24 or newer (the current LTS download). Then run:

```bash
npx @buildproven/wanderpage
```

It shows three steps — set up, install (about a minute, once), start Studio (about 30 seconds the first time) — then opens **Studio** in your
browser. Choose a photo folder, pick your privacy settings, and select **Build my Wanderpage**. Review the draft, then **Publish this story**.
Your shareable site is the `out/site/` folder inside the project (`./wanderpage` by default).

To try it with no key and no photos, open the built-in demo at `/demo`, or run `npm run trip:demo` inside the project.

Run the same command later to reopen Studio in the existing project. Pass a folder name to put the project somewhere else
(`npx @buildproven/wanderpage my-trips`). If you made a project with 0.3.0–0.3.2, delete that folder and run the command again.

### No Node.js yet? One line does it

The installer uses a Node.js 24+ you already have. If you have none, it downloads the official Node.js into `~/.wanderpage` (checking the
download's SHA-256 against nodejs.org's published list first) and starts Wanderpage with it. It does not change your PATH, shell profile, or any
system setting; delete `~/.wanderpage` to remove it.

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/buildproven/wanderpage/main/install.sh | sh
```

Windows (PowerShell; not tested yet, like the rest of Windows support):

```powershell
irm https://raw.githubusercontent.com/buildproven/wanderpage/main/install.ps1 | iex
```

Add a project folder or flags after `sh -s --` (`… | sh -s -- my-trips`), or on Windows run
`& ([scriptblock]::Create((irm https://raw.githubusercontent.com/buildproven/wanderpage/main/install.ps1))) my-trips`.
Set `WANDERPAGE_HOME` to keep the private Node.js somewhere else. Alpine Linux is not supported by the installer.

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

`out/site/` is a complete static website, and its home page is your story (or a list of your stories). Put the folder on any static host — for example
drag it onto [Netlify Drop](https://app.netlify.com/drop), or upload it to GitHub Pages, Cloudflare Pages, or S3 — or preview it locally:

```bash
npx serve out/site         # serves the shareable site locally
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

### From Claude Desktop (MCP)

`pnpm mcp` (inside a project checkout) serves a local MCP server over stdio, so Claude Desktop can edit a photo folder for you. Your photos
stay on this Mac; tools take folder paths. Add it to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wanderpage": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/wanderpage", "mcp"],
      "env": { "WANDERPAGE_WORKSPACE": "/path/to/wanderpage" }
    }
  }
}
```

Tools: `inspect_photos` (photo count, GPS and dates found), `create_draft` (folder, `people`, `locationPrivacy`, optional `title` and
`maxPhotos`; the draft stays private and the result states how many photos were selected, which is never fewer than 18 unless the folder
has fewer), `get_draft` (manifest and why each photo was selected), `list_drafts`, `edit_draft` (remove photos, set the hero, retitle, or
change captions of an unpublished draft, with the same checks as Studio), `preview_draft` (contact-sheet images of the selected photos,
built from the web images), and `publish_site` (publishes the draft, rebuilds `out/`, and runs the privacy scan; any finding is returned as
an error, nothing is deployed, and the draft keeps the published state it had before the call). `create_draft` with `people: "exclude"`
needs `OPENAI_API_KEY` in the server's environment. Keep `--silent`: standard output carries only MCP messages, and without it some pnpm versions print a `> wanderpage mcp` banner there that the client cannot parse.

## Troubleshooting

| You see                                                         | Do this                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Wanderpage needs Node.js 24 or newer…`                         | Install the current LTS from nodejs.org, or use the one-line installer above, then re-run.         |
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
- `WANDERPAGE_SITE_URL` — optional, e.g. `https://trips.example.com`. Adds the hero photo to link previews (Open Graph / Twitter); without it, previews carry the title and description only.
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
