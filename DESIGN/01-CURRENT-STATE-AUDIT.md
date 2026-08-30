# Current-state audit

Snapshot: 2026-08-29. Release decision: `HOLD`.

The native launcher now has a credible production-composed agent path. The latest dirty-tree evaluation passes 3,687 root tests, including 699 native tests with 38 environment-dependent skips. It covers checkpointed session recovery and compaction, MCP/Skill discovery and enablement, multi-process worker recovery, session-bound RPC/ACP projection, capability-checked provider adapters, redacted hooks, transactional browser settings, cache monitoring, and real PTY restoration, signal cleanup, lossless Unicode streaming, and guarded performance. These are implementation increments, not cutover approval.

Use the [traceability ledger](08-TRACEABILITY-CHECKLIST.md), [remaining-work plan](10-REMAINING-WORK-PLAN.md), and [RFC status](pi-coding-agent-removal/STATUS.md) for live state. The status log records the current full-gate receipt; older evidence documents remain immutable historical baselines.

## Current maturity

| Area | Maturity | What is verified | What still blocks release |
| --- | --- | --- | --- |
| Runtime and policy | Partial | Immutable prompt/tool prefixes, validation-before-persistence, plan and approval gates, cancellation bounds, and public event projection | Complete durable effect ledger, ambient-capability closure, real-provider fault matrix, and release receipts |
| Providers and tools | Composed | OpenAI Chat, Responses, and Anthropic protocol adapters; session-owned MCP reuse with elicitation/tasks/provenance; contained Skill lifecycle and settings controls | Credentialed external-provider runs, authentication/provider breadth, complete fault/restart corpus, and clean cross-host proof |
| Sessions | Partial | Production create/resume/switch/fork/name/export/navigation, locking, CAS, backup recovery, atomic writes, no-session isolation, and manual/threshold compaction | Parent/child graph navigation, import, overflow/corruption/crash corpus, and retained-reference proof |
| Workers and messaging | Verified dirty-tree increment | Owned-orphan recovery, dynamic approval/session-bound RPC/ACP projection, addressed event-bus messaging, and real multi-process tests | Scheduler and complete worktree lifecycle, clean candidate, independent-client, and cross-platform recovery evidence |
| Hooks and plugins | Partial | Filesystem discovery, normalized-hash review, explicit grants, command/MCP hook execution, bounded asynchronous ownership, lifecycle dispatch, transactional activation, rollback, ownership, and lease-safe unload | Pinned compatibility fixtures, formal capability/security approval, and clean cross-host adversarial proof |
| Settings | Partial | One loopback service and browser page, revision-safe writes, redaction, provider/MCP/Skill/plugin controls, portable export/import/reset, and browser save/focus/ARIA/mobile checks | Remaining configuration writers, recovery, cross-host conformance, and packaged-browser evidence |
| OpenTUI | Partial | Semantic widget controller, native input, accessible output, ask/plan/progress/task flows, and one real PTY exact-restoration run | Canonical package/assets, Node 26 FFI decision, alternate/masked/mouse paths, supported-platform and accessibility matrices |
| Conformance and release | Missing | Focused and dirty-tree integration evidence exists | Frozen clean before/after pair, real Pi/native oracle comparison, canary, rollback rehearsal, observation window, and zero-reference package proof |

## Highest-risk open facts

- The production session router and compaction path exist; the complete graph/import/overflow/corruption/crash corpus remains incomplete.
- Current provider proof is protocol-level and local; it is not a credentialed external-service matrix.
- Command/MCP hooks and bounded asynchronous execution are composed, but pinned compatibility and clean adversarial conformance are incomplete.
- Plugin execution fails closed, but the formal capability policy and user-facing grant workflow are not release-approved.
- One macOS PTY run is evidence for that host only. It does not satisfy the supported-platform gate.
- The conformance harness still needs two genuinely independent production adapters and a frozen Pi oracle.
- No canary, rollback rehearsal, observation window, or native-only closure receipt exists.

## Status vocabulary

| State | Meaning |
| --- | --- |
| Declared | A requirement, schema, or contract exists. |
| Isolated | A primitive exists but production does not reach it. |
| Partial | A production path exists but required behavior or evidence is incomplete. |
| Composed | The complete behavior is production-reachable; verification remains. |
| Verified | Focused and production-path checks pass for the named scope. |
| Cutover-ready | Real-host, security, platform, packaging, rollout, and rollback gates pass. |

Only `Cutover-ready` permits Pi removal.
