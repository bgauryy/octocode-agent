# Octocode agent Rust core

See [the architecture guide](ARCHITECTURE.md) for process ownership, durability
and filesystem flows, and dependency rules.

This package contains the native services packaged with the Octocode agent. The
durability actor owns
SQLite transactions for session events and their discovery index, effect
admission and settlement, settings revisions, communication leases, and
lifecycle streams. It also provides an immutable dependency-work ledger whose
claims and settlements are leased and fenced. On Unix the database file is
forced to owner-only mode (`0600`).

The process uses strict JSON Lines over stdin/stdout:

```bash
cargo build --manifest-path packages/octocode-agent-core-rust/Cargo.toml
packages/octocode-agent-core-rust/target/debug/octocode-agent-core-rust --db /absolute/path/core.sqlite3
```

Every request and response uses `schemaVersion: 1` and a caller-provided `id`.
The TypeScript launcher remains responsible for providers, MCP tool execution,
policy, projections, UI, and process supervision. Installed builds discover the
packaged services and fail closed when a required binary is unavailable.

The dependency-work methods are `work.putGraph`, `work.getGraph`, `work.claim`,
`work.heartbeat`, `work.complete`, and `work.fail`. `work.putGraph` validates a
complete bounded acyclic graph before its atomic insert. Claims return only
dependency-ready items in stable graph order. Expired claims may be taken over,
but every takeover increments the fencing token, so an earlier owner cannot
heartbeat or settle. Failure atomically marks unfinished descendants `blocked`.
These methods persist scheduling invariants; TypeScript still owns worker
capabilities, policy, effects, processes, and user-facing projections.

The required real-core verification lane is:

```bash
cargo test --manifest-path packages/octocode-agent-core-rust/Cargo.toml
cargo build --manifest-path packages/octocode-agent-core-rust/Cargo.toml
yarn workspace octocode-agent exec vitest run tests/native-rust-core.test.ts tests/native-rust-data-ports.test.ts tests/native-rust-runtime.test.ts --maxWorkers=1
```

Building first makes the subprocess cases mandatory; the tests skip only when
the opt-in binary has not been built at all.

## Filesystem service

Filesystem execution is a separate capability-rooted process; it does not enter
the SQLite actor dispatch loop. Unix uses descriptor-relative `openat`, `linkat`,
`renameat`, and `unlinkat` operations with no-follow flags. Windows uses
`cap-std`'s handle-based, beneath-root path resolver and same-directory temporary
files for compare-and-swap replacement:

```bash
cargo build --manifest-path packages/octocode-agent-core-rust/Cargo.toml --bin octocode-agent-fs
packages/octocode-agent-core-rust/target/debug/octocode-agent-fs \
  --workspace /absolute/workspace --max-bytes 10485760
```

The service uses the same `schemaVersion`, `id`, `method`, and `params` JSONL
envelope. It accepts `health`, `fs.authorizeExternalPath`, `fs.read`, `fs.hash`,
`fs.replace`, `fs.delete`, and the control method `cancel`. File content is
canonical base64. Paths are relative to the workspace descriptor opened at
startup and may not traverse symbolic links. `fs.authorizeExternalPath`
validates a regular input or a prospective output parent for a TypeScript-owned
external process; it does not execute the process or decide policy. `fs.replace`
uses `expectedSha256: null` for create-only and a lowercase SHA-256 digest for
replacement; deletion also requires the expected digest.

Every filesystem method also requires `maxBytes`. The per-call value must be
positive and no larger than the startup ceiling, so a caller can apply a tighter
read or write bound without starting another service.

Frames are bounded at 16 MiB, enough for a 10 MiB base64 payload and its JSON
envelope. At most four requests execute concurrently and mutations are
serialized. Cancellation is cooperative until the final namespace operation.
After link, rename, or unlink, the original request reports a committed result;
an error after that boundary includes `committed: true` rather than claiming
the operation was cancelled. Callers correlate responses by `id`; concurrently
submitted requests can complete out of order.

Linux, macOS, and Windows start the same versioned service contract. The Windows
backend rejects absolute paths, parent traversal, reparse/symbolic-link traversal,
and non-regular targets. Unsupported target families still fail closed at startup;
there is no lexical-containment or Node production fallback.

The isolated filesystem verification manifest avoids pulling SQLite into a
cross-target check:

```bash
cargo test --manifest-path packages/octocode-agent-core-rust/fs-runtime/Cargo.toml
cargo check --manifest-path packages/octocode-agent-core-rust/fs-runtime/Cargo.toml \
  --target x86_64-pc-windows-msvc --tests
```
