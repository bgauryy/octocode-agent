# @octocodeai/agent-testing

Deterministic host-conformance utilities for the native Octocode agent. The package defines the canonical production scenario matrix, drives attributed native production receipts through a comparison runner, hashes normalized traces and effect ledgers, and reports the first semantic divergence. It also evaluates signed release-closure receipts.

See [the architecture guide](ARCHITECTURE.md) for ownership and dependency rules.

## Host conformance

`CANONICAL_HOST_SCENARIOS` freezes the RFC's 14 production scenarios: lifecycle, deterministic turns, streaming tools, policy denial, tool failures, cancellation, steering/follow-up, sessions, compaction, UI, transports, persistence recovery, Codex hooks, and plugin lifecycle. Twelve are cross-host comparisons when two hosts are supplied. Codex hooks and executable plugin lifecycle are explicitly native host coverage.

`createCanonicalHostAdapter()` creates synthetic handlers for testing the comparison runner. A green result from two canonical handler tables is a runner self-test, not production parity evidence.

`createProductionNativeHostAdapter()` accepts receipts from native production
composition and built-native probes. It rejects a receipt attributed to the wrong
composition root and never supplies a harness or no-op runtime to a probe.
`runCanonicalHostConformance()` always returns one result per canonical scenario;
`runHostConformance()` accepts an explicit bounded subset. The native production
suite executes all 14 canonical scenarios through the built CLI and production
composition.

Each report identifies whether its baseline and candidate evidence is `synthetic` or `production`. A scenario is `matched`, `covered`, `diverged`, or `unsupported`. `covered` means one explicitly named host produced attributed evidence without a peer comparison. Unsupported coverage sets the report result to false and includes a reason for each host, so an incomplete adapter can't appear cutover-ready.

The runner normalizes sequence numbers, timestamps, request/session IDs, workspace paths, ANSI styling, errors, maps, and sets. Each scenario result includes separate SHA-256 trace and effect-ledger comparisons plus the first semantic divergence. Bounded host observations remain visible and separately hashed, but never participate in semantic trace or effect comparison. For example, persistence durable-entry counts are retained as observations while the restart assertion compares deterministic projection instead of discarding or fabricating entries. `EffectLedger` rejects duplicate effect IDs and prevents model, tool, process, network, write, or message effects during shadow execution.

## Release closure

`evaluateReleaseClosure()` is a fail-closed evaluator for the eight program gates
defined in `DESIGN/LEFTOVERS.md`. It accepts evidence; it does not manufacture or
sign it. Every gate needs exactly one passing receipt bound to the same clean
commit and artifact digest, an independent reviewer, and a caller-verified
signature. A missing or undersized canary yields `HOLD`; a breached canary abort
metric yields `ROLLBACK`. Only complete evidence can yield `GO`.
