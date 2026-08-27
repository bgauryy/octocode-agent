# Implementation Sequence

## Ordering principle

Build from invariant-owning foundations toward user-facing composition. Do not remove Pi or promote native while required behavior exists only as contracts, isolated classes, or fake-adapter tests.

## Phase 0 — Freeze truth and gates

- Adopt `08-TRACEABILITY-CHECKLIST.md` as the completion ledger.
- Mark every item declared, implemented, composed, verified, or cutover-ready.
- Replace ambiguous readiness claims with evidence links and check receipts.
- Define supported platforms, rollout thresholds, observation window, and rollback window.

Exit: every RFC requirement has one owner, production path, test path, and gate.

## Phase 1 — Runtime ownership and effect boundary

- Introduce runtime-owned scopes for turns, requests, tools, hooks, plugins, and transport work.
- Implement exactly-once terminal transitions and joined shutdown.
- Establish the single validation/trust/policy/lock/hook/approval/effect boundary.
- Add correlation IDs and structured error/usage lifecycle.

Exit: no effect can execute outside the boundary; cancellation and shutdown are deterministic.

## Phase 2 — Model, prompt, tool, and transport correctness

- Compose canonical prompt assembly and model-visible history.
- Validate models and thinking levels through the effective catalog.
- Complete strict streaming/tool-call parsing, typed stop/error normalization, and bounded retry.
- Validate tool input schemas.
- Make interactive and RPC pumps concurrent.
- Correct print/JSON/RPC lifecycle, correlation, errors, and exit codes.

Exit: real provider and transport integration suites pass.

## Phase 3 — Durable sessions

- Implement atomic cross-process commits and complete backup recovery.
- Restore full conversational context on resume.
- Implement the complete command set and graph-safe fork/rewind/navigation.
- Make no-session memory-only.
- Make migration transactional and byte-preserving.
- Integrate durable bounded compaction and partial-stream persistence.

Exit: crash, concurrency, migration, resume, branching, and compaction suites pass.

## Phase 4 — Hooks and plugins

- Implement discovery, review, matching, execution, decisions, queues, cleanup, and redaction.
- Compose blocking hooks before effects.
- Enforce manifest-bound grants and realpath containment.
- Compose plugin activation, contributions, leases, update, rollback, and unload.

Exit: a real native tool call can be blocked/rewritten by hooks, and plugins can activate/update/unload without residue.

## Phase 5 — Interactive TUI and settings

- Replace the text sink/readline split with one OpenTUI interaction system.
- Complete surfaces, keymaps, capabilities, coalescing, and restoration.
- Enforce headless dependency/protocol isolation.
- Wire native settings and unify the canonical registry/service with Pi.
- Complete secure Models/Hooks/Plugins/MCP/Skills control surfaces.

Exit: real PTY and settings security/conformance suites pass on every supported platform.

## Phase 6 — Real-host conformance

- Replace synthetic handlers with production Pi/native adapters.
- Implement shared effect-ledger enforcement and semantics-preserving normalization.
- Run every mandatory scenario in pure and shadow modes.
- Resolve every critical/high mismatch.

Exit: conformance evidence is based on real hosts and no duplicated external effects.

## Phase 7 — Rollout

- Ship shadow mode.
- Ship explicit canary with instant rollback.
- Promote native default only after thresholds and observation requirements pass.
- Exercise rollback using the release artifact and persisted sessions.

Exit: native default is stable and rollback is proven.

## Phase 8 — Pi removal

- Remove Pi launch and extension dependencies.
- Remove obsolete compatibility code, configuration, tests, and documentation.
- Verify clean install, supported upgrade, package contents, startup, all modes, and all platforms.
- Preserve only the explicitly defined rollback artifact/window.

Exit: the released product contains one native path and all checks remain green.

## Per-change workflow

For each package change:

1. Add or update a failing production-path test.
2. Implement the smallest coherent behavior.
3. Run `yarn workspace <package> test`.
4. Rebuild the changed package.
5. Run root lint and typecheck as appropriate.
6. Verify via the real CLI/MCP/RPC/PTY path.
7. Attach observed evidence to the corresponding traceability item.
