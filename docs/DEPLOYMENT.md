# Hosted preview deployment

Wanderpage's hosted creator is a server-backed Next.js application. The local
CLI and static export remain supported, but a Vercel deployment must use the
Next.js framework defaults rather than the local `out/` export directory.

## Vercel project settings

The repository declares the deployment contract in [`vercel.json`](../vercel.json):

- Framework: `nextjs`
- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm migrate && pnpm build`
- Output directory: unset (`null`); Vercel serves the Next.js server output

The migration command changes a database only when `VERCEL_ENV=production`.
It prefers `DATABASE_URL_UNPOOLED` and falls back to `DATABASE_URL`, applies
pending [`db/migrations`](../db/migrations) files in numeric order, and records
each committed file in `schema_migrations`. Each file and its ledger entry use
one transaction. A failed file rolls back and fails the deployment. Local and
preview builds print their reason for skipping migrations.
A production project with no database URL skips migrations and still builds;
the hosted routes then answer 503 naming the missing variables.

To adopt a database whose schema was applied by hand (tables but no
`schema_migrations` rows), the runner refuses to re-run the files and fails the
deploy. Set `MIGRATE_BASELINE` to the last file already applied (for example
`0007_mcp_owner_bindings.sql`) for one production deploy: the runner records
that file and every earlier one without running them, then applies the rest.
Remove the variable afterwards.

The `outputDirectory: null` declaration intentionally overrides a stale
dashboard output-directory setting. Do not set it to `out`: `out/` is produced
only by the local rollback export and contains no hosted API or private-story
route handlers.

The checked-in file is not proof that the Vercel project settings have
converged. Before hosted acceptance, run `vercel project inspect wanderpage`
and repair any live `Framework Preset: Other` or `Output Directory: out` settings
to `Next.js` and an unset output directory. Inspect the resulting deployment
again before enabling the creator.

## Required preview services

Create isolated preview resources before enabling the creator:

1. Neon Postgres database.
2. Private Vercel Blob store.
3. Vercel Workflow deployment for durable processing.
4. A non-production OpenAI key with a bounded spend limit.

Because builds never migrate preview databases, apply [`db/migrations`](../db/migrations)
to the isolated preview database before acceptance. Apply the files in numeric
order and record completion in the preview deployment notes. Never point a
preview at production data or a production Blob store.

## Environment variables

Set these in the Vercel preview environment only; never commit their values:

```text
DATABASE_URL
BLOB_READ_WRITE_TOKEN
OPENAI_API_KEY
WANDERPAGE_SESSION_PEPPER
WANDERPAGE_ADMISSION_PEPPER
WANDERPAGE_GENERATION_ENABLED=true
WANDERPAGE_OWNER_GENERATION_ENABLED
WANDERPAGE_DAILY_GENERATION_LIMIT
CRON_SECRET
WANDERPAGE_OPERATOR_SECRET
```

Production also accepts `DATABASE_URL`, but set `DATABASE_URL_UNPOOLED` when
Neon provides it so the build runner uses a direct migration connection.

Use separate random peppers and operator credentials for preview. Keep the
generation limit low enough to make accidental spend visible.

`WANDERPAGE_GENERATION_ENABLED` opens generation to anonymous (public)
sessions made through `/api/stories`. The browser creator is retired: the
Claude plugin is the only creator, and `/create` redirects (308) to `/`.
While it is not `true`, the signed-in hosted MCP owner can still create,
upload and generate stories, including through an upload link. Set
`WANDERPAGE_OWNER_GENERATION_ENABLED=false` to stop the owner too; leave it
unset (or `true`) to keep it on. Any other value fails the request. The daily
generation limit counts the owner's runs.

## Safe activation sequence

1. Deploy a preview from the exact reviewed commit.
2. Confirm `/demo` works before enabling generation.
3. Apply migrations and set the preview environment variables.
4. Keep `WANDERPAGE_GENERATION_ENABLED=false` while testing public and private
   route behavior.
5. Run the hosted preview acceptance command from the repository root with a
   synthetic photo fixture.
6. Enable generation only after the acceptance report is complete and the
   preview database and Blob objects have been inspected.
7. Revoke the preview credentials and delete the preview resources after the
   pilot unless they are explicitly retained.

The acceptance run must prove owner isolation, failed and retried processing,
explicit publish/unpublish/delete, private original cleanup, and metadata
privacy. A successful build or a Vercel `Ready` status is not hosted acceptance.

## Preview acceptance command

Run from the repository root against a reviewed Vercel preview. The harness
blocks production hosts, requires an explicit preview confirmation, uses six
synthetic PNGs, and deletes the story it creates:

```bash
WANDERPAGE_PREVIEW_URL=https://<deployment>.vercel.app \
WANDERPAGE_PREVIEW_ALLOWLIST=<deployment>.vercel.app \
WANDERPAGE_PREVIEW_CONFIRM=preview-only \
WANDERPAGE_HOSTED_SMOKE=1 \
pnpm hosted:preview
```

The smoke mode proves routing (including the `/create` redirect),
authentication, owner isolation, private upload on the `/stories/<id>` page,
and unpublished deletion without invoking generation. The harness creates its
story through `/api/stories`, so it needs `WANDERPAGE_GENERATION_ENABLED=true`
on the preview. After the preview has
been inspected and generation has been explicitly enabled, the full lifecycle
can be run with `WANDERPAGE_HOSTED_ACCEPTANCE=1` and
`WANDERPAGE_HOSTED_ALLOW_GENERATION=1` instead of `WANDERPAGE_HOSTED_SMOKE=1`.
Failed runs are failures, not acceptance evidence.

The enabled-preview pass must also inspect the private draft desk: return to an
existing anonymous-session draft, observe upload and curation status, retry a
failed run, save title and pre-processing privacy choices, and confirm that
publish, revoke, and delete remain explicit owner actions. Confirm that its
private summary does not expose exact GPS or unsupported location claims before
publishing.

## Production boundary

Provisioning external services, using real private photos, enabling chargeable
generation, and promoting a preview to production require explicit operator
approval. Missing configuration must remain a visible configuration error; the
application must not fall back to local files, public storage, mock AI, or a
static demo for hosted story creation.
