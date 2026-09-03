# Rust native-services architecture

`octocode-agent-core-rust` contains two supervised native services. They provide
durability and contained filesystem primitives to the TypeScript native host.
They don't run models, execute agent policy, render UI, or supervise workers.

## Process boundaries

| Binary | Owns | TypeScript adapter |
|---|---|---|
| `octocode-agent-core-rust` | SQLite transactions, revisions, indexes, effects, lifecycle streams, settings records, communication leases, and automation ledgers | `native-rust-core.ts`, `native-rust-data-ports.ts`, `native-rust-worker-messages.ts`, and `native-rust-automations.ts` |
| `octocode-agent-fs` | Capability-rooted reads, hashes, atomic replacement, deletion, bounded concurrency, and cancellation | `native-rust-file-system.ts` |

Both services use bounded, versioned JSON Lines with caller-provided request IDs.
The native launcher discovers packaged binaries beside the built launcher,
supervises their lifetime, correlates responses, and fails closed when a required
service is unavailable.

The SQLite actor uses the Agent-owned
`$OCTOCODE_HOME/agent/core.sqlite3`. It doesn't open the Agent control database
at `$OCTOCODE_HOME/agent/agent.sqlite3`, the workspace Awareness database at
`<workspace>/.octocode/awareness.sqlite3`, the optional global Awareness
database, or any CLI/MCP database. The launcher and actor reject a foreign store
identity before runtime schema writes. Worker lifecycle and communication
durability in `core.sqlite3` remain Agent-owned even when workers coordinate
through Awareness.

## Durability flow

```text
TypeScript semantic operation
  -> strict native adapter
  -> versioned JSONL request
  -> Rust transaction or lease operation
  -> correlated result
  -> strict TypeScript decoder
  -> core session/effect/settings/communication port
```

The SQLite actor serializes transactions that share durable invariants. Session
events and navigation indexes commit together. Effect acquisition and settlement
are idempotent. Communication and automation claims use leases plus fencing
generations so a stale owner cannot acknowledge or settle newer work.

Worker-process policy remains in TypeScript, while the actor can persist an
immutable dependency graph through the versioned `work.*` protocol. Graph
materialization validates the complete bounded DAG before its transaction writes
anything. Claims select only items whose prerequisites succeeded, serialize
across SQLite connections, and increment a durable fencing generation on every
expired-lease takeover. Completion and failure require the current owner,
generation, and live lease. A failed item atomically seals all unfinished
descendants as blocked, giving restart reconciliation one deterministic result
without executing or supervising a worker in Rust.

Rust stores canonical records but doesn't decide their meaning. TypeScript owns
settings validation and redaction, lifecycle semantics, communication
acknowledgement policy, schedule expansion, automation execution, and public
projection.

The executable Rust schema and protocol modules are the durable entity
inventory. Documentation intentionally avoids a fixed table count because
runtime entities evolve with versioned protocol methods.

## Filesystem flow

```text
model or runtime file request
  -> TypeScript schema, effect, trust, and approval pipeline
  -> NativeFileSystemPort
  -> capability-rooted Rust operation
  -> committed-aware result
  -> TypeScript tool result and effect settlement
```

The service opens one workspace capability at startup. Paths are relative,
symbolic-link and parent traversal fail closed, reads and frames are bounded,
and mutations require digest preconditions. `fs.authorizeExternalPath` validates
an existing regular input or a prospective output with an existing contained
parent before returning an adapter-only absolute host path; it does not execute
the external program or grant policy. Unix uses descriptor-relative operations.
Windows uses a handle-based beneath-root resolver. There is no production Node
fallback.

On Unix, checkpoint-enabled mutations use a separate, private filesystem journal
under the workspace capability. Preparation durably stores immutable transition
metadata plus content-addressed pre- and postimage blobs before apply begins.
Apply and rewind revalidate the exact journaled digest, absence, byte count, and
mode. Restart recovery reports `complete` when the after-image is present,
`partial` when the before-image remains, and `uncertain` on divergence or an
unobservable target. The store is hard-bounded to 128 MiB and 256 files, rejects
tampered records or blobs, and never enters the shared SQLite actor or a shadow
Git repository. Rewind creates a new journal transition; it does not mutate the
original effect or checkpoint.

## Dependency rules

- Keep model, prompt, tool, MCP, policy, approval, UI, calendar, graph intent,
  and worker-process semantics in TypeScript owners.
- Keep the filesystem service separate from the SQLite actor so filesystem
  latency cannot block session and lease transactions.
- Add a versioned protocol method only with strict request and response decoding,
  bounded inputs, idempotency or fencing semantics, and real subprocess tests.
- Don't execute arbitrary automation payloads or shell commands in Rust.
- Don't expose SQLite rows or filesystem handles as public agent contracts.

See the [service reference and verification commands](README.md), the
[native package architecture](../octocode-agent/ARCHITECTURE.md), and the
[completion ledger](../../DESIGN/LEFTOVERS.md).
