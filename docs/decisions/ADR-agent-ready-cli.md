# ADR: Agent-ready local CLI contract

## Status

Accepted for local-first delivery. This decision does not enable hosted
generation or change its preview admission gate.

## Decision

Expose local Wanderpage operations through one versioned command contract.
The command contract has structured JSON output for agents and concise human
output by default. It uses the existing local processing pipeline and static
publish controls; it does not add a second processor, a hosted API, or an
autonomous publisher.

The supported local operations are:

1. inspect a photo folder without provider calls or persistent writes;
2. create a private draft or deterministic demo;
3. list and inspect existing drafts;
4. validate a draft's artifact privacy before publication;
5. publish or unpublish an existing local draft only after an explicit command.

Every structured result includes `contractVersion`, `operation`, and an action
receipt. A receipt records whether the operation changed local state. It is an
audit aid, not an authorization credential.

The protocol is `wanderpage/v1`. Commands write exactly one JSON result to
standard output when `--json` is set. Human progress and errors go to standard
error. The success envelope is `{ contractVersion, operation, ok: true, data,
receipt }`; the error envelope is `{ contractVersion, operation, ok: false,
error: { code, message } }`. Unknown JSON fields are never accepted because
commands receive flags, not JSON input. A later incompatible protocol uses a
new major contract version and command flag, rather than changing v1 fields.

Exit codes are `0` for success, `2` for invalid arguments, `3` for a policy or
validation failure, `4` for a missing local target, and `10` for an unexpected
failure. The CLI does not write a partial JSON success result after an error.

## Context

The current repository has a working local CLI, Studio UI, and hosted draft
service. The local scripts are useful to people but have no stable output
schema for a tool-using agent. The hosted service uses anonymous browser
sessions and remains preview-gated; it is not an agent delegation interface.

## Invariants

- The CLI never identifies people or weakens `--people exclude` behavior.
- The default privacy mode remains `approximate`; `exact` is not added to the
  new command contract.
- `inspect`, `list`, `show`, and `validate` do not call a model and do not
  change a workspace.
- `create` makes a private local draft. It never publishes as a side effect.
- `publish` and `unpublish` require a separate explicit command. `publish`
  performs final fail-closed artifact privacy validation itself; it may not
  rely on a previous `validate` command.
- A successful validation receipt includes the exact manifest digest and asset
  tree digest. `publish` recalculates both digests and rejects a changed,
  invalid, or missing private draft before it changes publication state.
- A workspace is the canonical real path of the current directory or explicit
  `--workspace` directory. Commands reject a workspace outside that root,
  symlinked draft paths, path traversal, and draft identifiers that do not
  match the generated slug grammar. They only read or write approved
  `data/trips`, `.trip-assets`, `.trip-cache`, `.trip-output`, and generated
  `public/trip` locations below that workspace.
- New drafts use a unique slug. Existing draft assets are never overwritten by
  a create operation. Publish and unpublish only mutate an existing manifest
  addressed by its validated slug.
- Existing `pnpm trip`, `trip:publish`, and `trip:unpublish` remain supported
  as compatibility commands during this migration.
- The CLI has no remote credential, hosted session, deploy, or release action.

## Alternatives

### Keep the existing scripts and ask agents to parse text

Rejected. Text output is not a stable contract and makes agent execution
fragile.

### Add a hosted agent API first

Rejected. Hosted creation lacks production acceptance and durable delegated
identity. It would widen authority before the local contract is proven.

### Let `create` publish automatically

Rejected. Publication is an external, potentially irreversible action and
requires a distinct human or authorized-agent command.

## Rollback

The new commands are additive. Removing them leaves the existing scripts and
Studio flow intact. No data migration, remote configuration, or public API is
introduced.

## Verification

- Unit tests inspect versioned JSON results and action receipts.
- CLI subprocess tests prove a deterministic demo can be created, inspected,
  validated, published, and unpublished through an isolated workspace.
- Read-only operations run with a deny-provider dependency and a filesystem
  boundary recorder. Tests prove that success and failure paths make no writes
  inside or outside the workspace and make no network/provider calls.
- Containment tests reject traversal, symlinked draft paths, and workspace
  escapes. Publication tests reject invalid, modified, and unvalidated drafts.
- Existing `pnpm check` proves current Studio, static export, and privacy
  behavior continue to work.
