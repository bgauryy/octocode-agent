# Remaining-work plan

Status: active dependency index; reconciled 2026-08-28; release remains `HOLD`.

This page groups work that is still required. It does not duplicate feature definitions or claim current release state. [RFC status](pi-coding-agent-removal/STATUS.md) owns blockers, [RFC steps](pi-coding-agent-removal/STEPS.md) owns execution order and stop conditions, and the [traceability ledger](08-TRACEABILITY-CHECKLIST.md) owns maturity.

## Verified dirty-tree increments — do not redo

The current candidate already includes these bounded increments:

- immutable prompt/tool prefix and cache routing hardening;
- OpenAI Chat, Responses, and Anthropic protocol adapters;
- owned-orphan recovery and approval/session-bound worker RPC projection;
- filesystem hook/plugin discovery, normalized-hash review, explicit grants, command hooks, transactional activation, rollback, ownership, and lease-safe unload;
- protected browser settings save, focus/ARIA/mobile checks, and provider visibility;
- effective model-catalog selection and atomic provider/model writers;
- runtime-owned safe provider retry, durable native effect admission, expanded
  JSON Schema validation, and bounded non-cooperative tool cancellation;
- canonical non-empty composite effect sets, versioned policy/admission receipts,
  native receipt persistence, and altered-receipt replay denial;
- fail-closed Octocode catalog/version/count/output validation and typed redacted
  facade failures, while the production `npx` authority decision remains open;
- durable manual compaction with restart recovery and built-RPC execution;
- production session create/resume/switch/fork/name/export and previous/next/parent/child navigation through replacement fixed-session runtimes;
- automatic threshold compaction with bounded failure handling;
- typed synchronous MCP hook execution plus bounded, owned asynchronous hook drain/cancellation;
- transactional plugin/hash review and capability grant/revoke settings actions;
- print, JSON, RPC, and ACP signal ownership with bounded cleanup;
- same-turn steering at model-safe points with FIFO follow-ups and no completed-effect replay;
- aggregate per-turn tool-result bounds and environment-complete native catalog cache keys;
- collision-resistant session and turn identities, backup-aware explicit resume,
  fork-reference repair, and correlation-closed retained compaction context;
- immutable terminal effect outcomes and durable admission identities across restart;
- strict cross-process MCP task transactions with corruption preservation,
  bounded locks, stale-lock recovery, private atomic replacement, and fsync;
- strict plan parsing, live file-backed policy state, stale-lock recovery, and
  host-owned verification receipts that reject caller authority;
- runnable production Pi/native conformance adapters with an honest HOLD ledger;
- one real macOS pseudo-terminal exact-restoration smoke run.

The integrated receipt is [real runtime surface evaluation](pi-coding-agent-removal/evidence/real-runtime-surface-eval-2026-08-28.md). These results must be reproduced from the clean release candidate; they do not close broader gates.
The current production-adapter conformance result is 0 matched, 1 divergent, and
13 unsupported scenarios.

## Ordered work groups

| Order | Work group | Remaining outcome | Required evidence | Stop gate |
| ---: | --- | --- | --- | --- |
| 1 | `DOC` — authority and baseline | Active docs agree; candidate commit and dirty-state are frozen; historical receipts remain immutable | Link/style/contradiction report and signed canonical-before receipt | No stage advancement from an unfrozen tree |
| 2 | `ADR` — ownership decisions | Runtime/provider ownership, pinned external tool facade, authoritative upstream effects/lock targets, settings lifecycle, complete durable receipt semantics, and conformance package home are accepted | ADR/RFC deltas plus boundary and negative tests | No parallel implementations of the same authority |
| 3 | `SES` — durable sessions | Complete import, corruption recovery, overflow compaction, source hashes, leases, and restart behavior around the production fixed-runtime router | Replay equality, crash/retry, stale-writer, migration, corruption, and resumable-compaction suite | No lossy migration or non-idempotent replay |
| 4 | `RUN` — runtime and providers | Credentialed provider runs, explicit retry ownership, complete cancellation/effect receipts, MCP lifecycle/tasks/elicitation/provenance, and complete Skill discovery/activation | Real-provider and fault matrix, protocol fixtures, cache telemetry, and production composition tests | No ungoverned side effect or hidden retry layer |
| 5 | `ORCH` — workers and communication | Complete scheduler dependencies, full worktree lifecycle, handoff completion, restart reconciliation, and platform-safe process cleanup around the composed RPC/ACP worker projection | Multi-process crash/restart/dead-pipe/concurrency tests through headless and editor transports | No worker escapes session, approval, trust, or ownership boundaries |
| 6 | `EXT` — hooks and plugins | Pin compatibility fixtures and complete formal capability policy around the production-composed command/MCP and synchronous/asynchronous hook paths | Negative security matrix, exact fixtures, real filesystem packages, unload/rollback/fault receipts | Unknown or stale code remains non-executable |
| 7 | `SET` — configuration control plane | Complete cross-host projection and the remaining models/providers, MCP, Skills, sessions, diagnostics, and reset/import/export controls around the canonical service | Cross-host snapshots, browser/security/accessibility suite, concurrent-write, and rollback tests | No secret disclosure or direct-writer bypass |
| 8 | `TUI` — terminal release matrix | Approved OpenTUI package route, non-experimental or explicitly supported FFI policy, packed assets, full interaction/accessibility coverage, and exact restoration on supported platforms | Clean packed install, real PTY matrix, keyboard/screen-reader/resize/mouse/masked/alternate-output receipts | No terminal corruption or inaccessible required action |
| 9 | `CONF` — real-host parity | Frozen Pi oracle and native adapter run independent canonical scenarios with normalized outputs and classified differences | Signed before/after, performance, security, migration, and fault comparison | Synthetic shared handlers cannot count as parity |
| 10 | `REL` — rollout and removal | Thresholds, canary, rollback rehearsal, observation window, zero-reference artifact, dependency cleanup, and final native-only closure | Canary telemetry, rollback receipt, clean install/upgrade, package tree, and closure receipt | Pi removal is forbidden until every prior gate passes |

## Cross-cutting checks

Every work group must:

1. start with a failing test or measurable baseline;
2. prove the production composition path, not only an isolated class;
3. preserve prompt and tool-prefix stability unless a versioned contract intentionally changes;
4. route effects through trust, permission, approval, plan, hook, lock, and receipt policy;
5. keep interactive, print, JSON, RPC, MCP, and editor projections semantically aligned;
6. rebuild changed packages and run their workspace tests before integration;
7. attach exact commands, versions, fixture hashes, and observed output to a dated receipt;
8. update `STATUS.md`, this plan, and the traceability ledger together when maturity changes.

## Release-critical leftovers

The release remains blocked by the clean candidate; complete real-host parity;
session import, partial-assistant crash durability, overflow compaction, and crash matrices; authoritative upstream
effect/lock metadata and complete extension policy; credentialed providers; complete
settings UX; supported-platform PTY/accessibility evidence; canary thresholds;
rollback rehearsal; and the observation window. Command/MCP hooks, bounded async
hook ownership, and dynamic RPC/ACP worker projection are locally composed; clean
cross-host conformance and the complete adversarial matrices remain explicit gaps.

The detailed acceptance rules stay in the RFC specialist documents. Add new requirements there first; do not expand this page into a second specification.
