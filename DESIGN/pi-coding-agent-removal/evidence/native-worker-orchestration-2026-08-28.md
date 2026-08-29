# Native worker orchestration evidence — 2026-08-28

Status: **Accepted dirty-tree increment; release remains HOLD**

## Implemented scope

- `@octocodeai/agent-core` owns one host-neutral `WorkerSupervisor` for typed spawn packets, immutable capability snapshots, bounded FIFO concurrency, correlated input, terminal settlement, abort, kill, and joined shutdown.
- The supervisor fails closed if its durable ledger cannot commit. It resolves shared waiters exactly once and normalizes child crashes without exposing process errors.
- `octocode-agent` provides a persistent JSONL RPC process adapter. It validates protocol versions and monotonic event sequences, bounds output, handles split UTF-8, correlates responses, and maps send, steer, follow-up, cancel, terminate, and kill operations.
- The native `worker` tool creates worker, packet, correlation, and session identities internally. Its closed schema bounds delegated tools, model, turns, text, wait duration, and workspace mode. Worktrees fail closed.
- Worker lifecycle events persist in the canonical Awareness SQLite database. Packet IDs are idempotent, replay is ordered and scoped, raw prompts and queued input are replaced with hashes and byte counts, and handback text is bounded.
- Child processes receive an allowlisted environment, an immutable prompt digest, and explicit tool/model/turn capabilities. The child validates the prompt digest and only registers delegated tools. It cannot register the worker tool recursively.
- Headless worker execution requires the explicit `--allow-workers` option and a trusted workspace. Without both conditions, the existing policy and approval boundary denies spawn.

## Verification

- `yarn workspace @octocodeai/agent-core verify` — 82 tests passed.
- `yarn workspace @octocodeai/octocode-awareness verify` — 996 tests passed.
- `yarn workspace octocode-agent verify` — 423 tests passed and 16 skipped.
- `yarn workspace @octocodeai/agent-core build`
- `yarn workspace @octocodeai/octocode-awareness build`
- `yarn workspace octocode-agent build`
- Built RPC smoke: the parent `tools.list` includes `worker` with process/workspace/on-request policy.
- Built child RPC smoke: `OCTOCODE_NATIVE_WORKER=1` plus one delegated tool exposes only that tool; `worker` is absent.

## Open gates

This increment does not complete `ORCH-005`, `ORCH-006`, or the release gate. The following evidence remains required:

- a real two-process spawn/send/steer/follow-up/abort/escalation and open-handle corpus;
- restart reconciliation for an orphaned operating-system child and replay of an unfinished worker;
- direct editor and RPC worker projections that enter the same runtime policy boundary without a bypass;
- Awareness-addressed worker mailbox and handoff acceptance across process restart;
- dependency-ready scheduling, leases, path ownership, and complete worktree create/retain/merge/discard recovery; and
- clean candidate, platform, packed-artifact, canary, rollback, and Pi-retirement receipts.
