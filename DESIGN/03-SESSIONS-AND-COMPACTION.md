# Sessions and compaction

Status: target design and acceptance contract  
Scope: native session identity, event persistence, projection, migration, context restoration, branching, and compaction  
Owning requirements: `RFC.md` §Session and persistence contract; `SCHEMAS_AND_TYPES.md` §Session schemas and types; `TEST_PLAN.md` §Sessions and compaction

## Purpose

The native runtime must treat a session as durable product state, not merely a
filename selected at launch. A successful resume restores the exact approved
model context and user-visible transcript. Mutating operations preserve one
validated branch graph, one monotonic revision history, and a recoverable last
commit. Ephemeral operation writes no session artifact. Pi migration reads the
source without modifying it and either commits one complete native destination
or commits nothing.

The filesystem is a host adapter. Agent core owns event schemas, projection,
session commands, graph semantics, compaction state, and typed failures. The
native package owns locking, files, synchronization, recovery, legacy file
access, and CLI composition. Model, terminal, HTML, RPC, and Pi-specific types
must not cross the core boundary.

## Current-state gaps

The dirty-tree implementation is a useful seam, but it is not the target:

- Native resume selects a stored ID and revision but does not hydrate prior
  transcript messages into the model request. New work therefore appends to an
  old file while the model behaves as if the conversation were new.
- Canonical runtime commands declare create, resume, switch, fork, navigate,
  name, export, compact, and cancel-compaction, but the runtime kernel returns
  `unsupported-capability` because no session service is composed.
- The launcher exposes listing and process-level resume. It has no implemented
  switch, fork-at-entry, tree navigation, rewind, export, or import workflow.
- `--no-session` creates a `memory:<pid>` identity but still uses the filesystem
  store and writes a normal record.
- Filesystem optimistic concurrency is a check followed by an unlocked rename.
  Concurrent writers can both accept one revision and lose an append.
- Backup recovery handles a corrupt primary but not a missing primary. Directory
  synchronization failures are ignored, and interrupted temporary files have no
  explicit recovery or cleanup protocol.
- Legacy import checks the source digest again only after committing the
  destination. A changed source can therefore produce a failed import with a
  partially committed destination. Invalid JSONL lines also lose their original
  bytes when converted to an opaque marker.
- Record validation checks envelope shape and sequence, but does not fully
  validate event payloads, event revisions, visibility, graph references, or
  compaction references. Unknown discriminants can be silently ignored.
- Fork copies the whole source and rewrites event IDs without remapping every
  event reference. Fork-at-entry, ancestry, leaf selection, and rewind are not
  implemented.
- Assistant text deltas are buffered only in memory until a graceful boundary;
  abrupt termination can lose a visible partial response.
- The compaction state machine is not composed or persisted, permits unbounded
  retry, and cannot begin another compaction after a terminal state.

These statements are implementation gaps, not compatibility permissions. The
target below is authoritative for completion.

## Canonical identity and record model

### Identity

- `SessionId`, `SessionEventId`, and `BranchId` remain distinct branded values.
- A new durable session ID is collision-resistant across concurrent processes.
  Time alone is not sufficient.
- The root branch has one stable ID. Every non-root branch identifies its parent
  branch and fork point.
- A session has one selected leaf. A selected leaf must exist in the graph.
- Names are metadata events. Renaming never changes identity or storage path.

### Durable envelope

One committed record contains:

- envelope schema version and session ID;
- durable revision;
- ordered, append-only canonical events;
- integrity metadata required by the selected storage prototype;
- optional recovery metadata that does not affect semantic projection.

For revision `N`, the envelope contains exactly the events committed through
revision `N`. Each event has the same session ID, a unique event ID, a positive
monotonic sequence/revision, an integer timestamp, a valid visibility value,
and a fully validated discriminated payload. The projector rejects:

- duplicate or missing sequence/revision values;
- duplicate event, branch, or artifact identities;
- unknown envelope or event schema versions;
- unknown native event discriminants;
- invalid payloads or visibility values;
- missing parents, cycles, invalid fork points, or invalid selected leaves;
- parent-event and retained-event references outside the record;
- compaction records whose retained set violates the compaction contract.

Forward Pi data enters through `opaque.imported`; arbitrary unknown native event
types are never silently accepted.

## Projection and context restoration

Projection is a pure deterministic fold over validated events. It produces:

- session identity, name, durable revision, and selected branch;
- branch ancestry and ordered events visible at the selected leaf;
- transcript messages with stable event identities;
- model-context messages after visibility and compaction rules;
- durable custom entries excluded from model context by default;
- artifacts and diagnostics;
- the latest completed compaction and active retry metadata.

Resume and switch must load and validate the record, select the requested or
stored leaf, project it, and initialize the model loop with the projected model
context before accepting input. The first provider request after resume must
contain the same normalized context as uninterrupted execution. Tool calls and
tool results preserve their correlation IDs and ordering.

Transcript projection and model-context projection are separate named
functions. Presentation-only and diagnostic events do not enter model context.
Custom entries enter it only through an explicit versioned transformation.

## Session operations

Every operation is a canonical service invoked by the runtime, CLI, JSON/RPC,
and supported adapters rather than reimplemented by a transport.

### Create

Create allocates or validates an unused session ID, commits the session-created
event and root-branch selection atomically, records the trusted canonical
workspace identity, and makes the session current. Collision returns a typed
conflict; it never resumes implicitly.

### Resume and switch

Resume requires an existing valid session. Switch first reaches a safe point in
the current runtime, then loads, projects, and activates the destination. A
missing, corrupt, unsupported-version, or locked session returns a typed error
and leaves the previous current session unchanged. Resume and switch emit the
canonical lifecycle sequence exactly once.

`--continue` resolves according to an explicit policy: a valid per-terminal
bread crumb when supported, otherwise the newest compatible session for the
canonical workspace, otherwise create new. Stale or mismatched breadcrumbs are
ignored and diagnosed. Selection never relies on an unvalidated filename.

### Name

Name appends a metadata event at the expected revision. Empty, oversized, or
invalid names fail validation. Concurrent rename conflicts do not overwrite a
newer name.

### Fork

Fork takes source session, destination identity, and an explicit fork event or
leaf. It copies or references only history reachable at that point, remaps every
event reference deterministically, records source ancestry and fork point, and
selects the new branch. The source is unchanged. Missing sources, invalid fork
points, destination collisions, and graph-invalid results fail without a
destination commit.

### Tree navigation and rewind

Navigation addresses a branch/leaf or an unambiguous relative direction and
commits branch selection without deleting history. Rewind selects the state at
a validated event and creates the approved branch/fork representation; it does
not truncate or rewrite the source log. Parent/child/previous/next behavior is
deterministic and stable across export/import.

### Export

Export reads one validated snapshot and emits a versioned, deterministic,
secret-reviewed representation through the selected transport. It includes
identity, ancestry, transcript, custom-entry metadata, artifacts, compaction
receipts, and integrity information as allowed by the format. Export is
read-only, never depends on private Pi modules, and never mutates access times or
session contents where the platform permits.

## Ephemeral `--no-session`

No-session mode uses an in-memory `SessionStore` and a process-local identity.
It must not create a primary, backup, temporary, lock, breadcrumb, inventory,
import, or recovery artifact. It may project transcript/context for the life of
the process. Resume, switch, fork-to-durable, export-to-path, and other durable
mutations require an explicit supported conversion or return a typed
unsupported result. Tests inspect the whole configured home before and after.

## Filesystem transaction protocol

The filesystem adapter implements one linearizable commit per session:

1. Resolve the destination under the canonical sessions directory and reject
   symlinks, traversal, unexpected file types, and path changes.
2. Acquire the approved per-session lock or equivalent cross-process atomic
   exclusion mechanism.
3. Read and fully validate the durable primary, recovering the valid backup if
   the primary is missing or invalid.
4. Compare the durable revision with `expectedRevision` while exclusion is held.
5. Serialize and validate the complete next envelope.
6. Write a uniquely created temporary file in the destination directory with
   restrictive permissions; write all bytes and fsync the file.
7. Preserve the previous valid primary as the recovery generation without
   exposing an invalid backup.
8. Atomically rename the new file over the primary and fsync the directory.
9. Release the lock and report the committed revision.

Any failure before the primary rename leaves the previous primary readable. Any
failure after rename is classified according to whether durability can be
proven. Directory-fsync failure cannot be silently reported as a durable
success. Temporary and stale-lock cleanup is bounded and never deletes an
artifact owned by a live writer.

Recovery examines primary, backup, and recognized temporary generations. It
selects only a fully valid committed generation under a documented rule,
restores it atomically, records a redacted recovery receipt, and never guesses
between two valid divergent revisions. An unrecoverable or ambiguous state
fails closed with `session-corruption` or `session-conflict`.

## Migration and source immutability

Pi JSONL migration always targets a different native destination. The source is
opened read-only and its path, metadata, and SHA-256 digest are recorded before
reading. Parsing preserves record order and the exact bytes or an approved
irreversible representation of malformed/unknown records in `opaque.imported`.

The importer builds and validates the complete native candidate without a
destination mutation, obtains the source digest again, and commits only if both
digests match. Destination existence, source change, parse policy failure,
graph failure, or commit failure leaves the destination absent and source bytes
unchanged. The receipt records source identity/digest, destination identity and
revision, translated/opaque/error counts, schema versions, and normalizer
identity without exposing sensitive contents.

Migration is idempotent by an explicit source-digest/import identity. Retrying a
successful import returns or verifies the same result; retrying a failed import
does not encounter a partial destination. The corpus covers real dated Pi
shapes through synthetic or irreversibly redacted fixtures.

## Streaming durability

Visible user input is durably appended before or at the point the runtime
accepts it. Assistant streaming uses one of two approved designs:

- append versioned delta/checkpoint events and deterministically coalesce them
  into one logical transcript message; or
- maintain an atomic in-progress message record with durable checkpoints and
  finalize it once.

In either design, a crash may leave a typed interrupted assistant message but
must not silently erase text already presented as durable. Restart recovers the
partial state exactly once, preserves tool-call/result correlation, and never
duplicates assistant messages. Cancellation, provider failure, runtime failure,
normal stop, and hard termination each have a deterministic terminalization or
recovery rule.

## Compaction design

Compaction is a session transaction, not an isolated UI state machine.

- Reasons are `manual`, `threshold`, and `overflow`.
- Each attempt has stable identity, source revision, reason, attempt number,
  context measurement, and cancellation ownership.
- Only one attempt is active per session revision.
- Success appends a compaction record containing the summary, validated retained
  event IDs, source range, and projection/version metadata.
- Failure and cancellation append or expose the approved durable terminal state
  without changing the last usable model context.
- Retry has a configured finite limit and reason classification. Overflow retry
  cannot loop indefinitely or repeatedly compact the same unchanged revision.
- A later compaction may start from a completed/failed/cancelled prior operation;
  terminal applies to an attempt, not the lifetime of the session.
- Resume reconstructs compaction state. An interrupted active attempt becomes a
  deterministic recoverable/failed state before new compaction starts.
- The projector proves every retained ID exists and produces the same context
  before and after restart.

Automatic threshold and overflow triggers live in composed runtime policy.
Manual and cancel commands use the same service and lifecycle events. No
transport mutates compaction state directly.

## Errors and observability

All external failures use canonical typed categories: conflict, corruption,
migration, persistence, unsupported version/capability, validation, cancelled,
and internal invariant. Launcher adapters preserve category and safe remediation
instead of replacing it with a generic load error.

Receipts correlate session ID, operation ID, expected/observed revision,
recovery generation, source digest, branch/fork identity, compaction attempt,
and terminal outcome. Paths and content are redacted according to policy. No
receipt contains prompt text, tool results, secrets, or raw sensitive entries.

## Acceptance criteria

The session/compaction design passes only when all of the following hold:

- New, resume, continue, switch, fork-at-entry, tree navigation, rewind, name,
  list, export, and no-session work through native CLI and versioned RPC where
  supported.
- The first model request after resume/switch equals uninterrupted projected
  context under the canonical normalizer.
- Pi/native conformance preserves ancestry, leaf selection, transcript order,
  custom-entry visibility, tool correlation, and approved compaction semantics.
- Expected-revision conflicts are linearizable across processes and never lose
  an accepted append.
- Every injected write/fsync/rename/lock interruption yields either the old or
  new valid commit, never a mixed record or silent success.
- Missing/corrupt primary recovery, corrupt backup, divergent generations,
  stale temporary files, and stale locks follow deterministic fail-safe rules.
- Import leaves source bytes/hash unchanged and has all-or-nothing destination
  behavior for success, changed source, corruption, cancellation, and crash.
- Record and graph validation reject every malformed envelope, payload,
  revision, reference, cycle, leaf, and unsupported native schema.
- Visible streamed transcript survives restart without loss or duplication.
- Manual, threshold, overflow, retry, success, failure, cancellation, restart,
  and retry-exhaustion compaction scenarios reach one valid attempt terminal
  state with no loop or lost durable state.
- No-session leaves the configured home byte-for-byte/artifact-inventory
  unchanged except explicitly unrelated state approved by the test.
- Source, package, built-artifact, and dependency checks keep filesystem types
  outside agent core and Pi-specific parsing outside the native domain model.

Any data loss, source mutation, duplicate effect/message, graph corruption,
silent revision overwrite, compaction loop, protocol corruption, or durable
write in no-session mode is a zero-tolerance failure.

## Required test matrix

### Core unit and property tests

- Deterministic projection and idempotent replay over generated valid logs.
- Rejection properties for sequence/revision gaps, duplicates, payload/schema
  errors, invalid visibility, bad references, cycles, and invalid leaves.
- Controller tests for every operation, no-active-session, missing session,
  destination conflict, safe-point failure, and unchanged-current rollback.
- Fork-at-every-event tests with complete reference remapping and ancestry.
- Context projection tests separating transcript, model, custom, diagnostic, and
  compacted visibility.
- Compaction transition/property tests for all reasons and terminal states,
  finite retries, repeated compactions, cancellation races, and restart.

### Filesystem adapter tests

- Two and many concurrent processes appending from the same revision; exactly
  one wins and losers receive typed conflicts.
- Fault injection before/during/after temp write, file fsync, backup publication,
  primary rename, directory fsync, and lock release.
- Valid/corrupt/missing primary crossed with valid/corrupt/missing backup and
  recognized temporary generations.
- Permissions, symlink/path traversal, unexpected file types, stale locks,
  cleanup, disk-full, read-only filesystem, and platform path cases.
- Real restart tests, not only in-memory record-port simulations.

### Migration tests

- Empty, ordinary, named, tool, custom, branch, tree, rewind, compacted,
  interrupted, malformed/truncated, unknown-future, Unicode/RTL, large-payload,
  and platform-path Pi fixtures.
- Source modification during every parse/validation/commit boundary.
- Source byte, metadata, and digest immutability; destination all-or-nothing;
  deterministic receipt and idempotent retry.
- Malformed-line byte preservation and opaque-record ordering.

### Runtime and transport tests

- New versus resumed provider-request equality and post-resume continuation.
- Switch/fork/tree/rewind while idle and rejection during unsafe active states.
- CLI and RPC list/name/export/import/resume error and protocol-purity cases.
- Hard termination at every streamed-delta boundary followed by recovery.
- No-session across interactive, print, JSON, and RPC with full home inventory.
- Compaction trigger, cancellation, overflow retry, provider failure, restart,
  and post-compaction continuation.

### Conformance and release tests

- The shared Pi/native corpus required by `TEST_PLAN.md`, including identical
  normalized ancestry, selected leaf, transcript, context, and terminal states.
- Performance samples for append commit, replay/projection, import, compaction,
  resume-to-ready, and recovery under equivalent storage conditions.
- Clean packed-artifact import/export/resume tests on every supported operating
  system, architecture, and filesystem policy.
- Artifact rollback proves prior releases can still read supported sessions and
  that native migration never rewrites the Pi source.

Completion requires a commit-addressed receipt containing exact commands,
fixtures and hashes, fault points, counts, failures/skips, supported platforms,
first semantic differences, and independent session/testing/release review.
