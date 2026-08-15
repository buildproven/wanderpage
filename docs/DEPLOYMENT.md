# Hosted preview deployment

Wanderpage's hosted creator is a server-backed Next.js application. The local
CLI and static export remain supported, but a Vercel deployment must use the
Next.js framework defaults rather than the local `out/` export directory.

## Vercel project settings

The repository declares the deployment contract in [`vercel.json`](../vercel.json):

- Framework: `nextjs`
- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm build`
- Output directory: unset (`null`); Vercel serves the Next.js server output

The `outputDirectory: null` declaration intentionally overrides a stale
dashboard output-directory setting. Do not set it to `out`: `out/` is produced
only by the local rollback export and contains no hosted API or private-story
route handlers.

## Required preview services

Create isolated preview resources before enabling the creator:

1. Neon Postgres database.
2. Private Vercel Blob store.
3. Vercel Workflow deployment for durable processing.
4. A non-production OpenAI key with a bounded spend limit.

Apply [`db/migrations`](../db/migrations) in numeric order in one migration
transaction. Never point a preview at production data or a production Blob
store.

## Environment variables

Set these in the Vercel preview environment only; never commit their values:

```text
DATABASE_URL
BLOB_READ_WRITE_TOKEN
OPENAI_API_KEY
WANDERPAGE_SESSION_PEPPER
WANDERPAGE_ADMISSION_PEPPER
WANDERPAGE_GENERATION_ENABLED=true
WANDERPAGE_DAILY_GENERATION_LIMIT
CRON_SECRET
WANDERPAGE_OPERATOR_SECRET
```

Use separate random peppers and operator credentials for preview. Keep the
generation limit low enough to make accidental spend visible.

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
WANDERPAGE_PREVIEW_CONFIRM=preview-only \
WANDERPAGE_HOSTED_SMOKE=1 \
pnpm hosted:preview
```

The smoke mode proves routing, authentication, owner isolation, private upload,
and unpublished deletion without invoking generation. After the preview has
been inspected and generation has been explicitly enabled, the full lifecycle
can be run with `WANDERPAGE_HOSTED_ACCEPTANCE=1` and
`WANDERPAGE_HOSTED_ALLOW_GENERATION=1` instead of `WANDERPAGE_HOSTED_SMOKE=1`.
Failed runs are failures, not acceptance evidence.

## Production boundary

Provisioning external services, using real private photos, enabling chargeable
generation, and promoting a preview to production require explicit operator
approval. Missing configuration must remain a visible configuration error; the
application must not fall back to local files, public storage, mock AI, or a
static demo for hosted story creation.
