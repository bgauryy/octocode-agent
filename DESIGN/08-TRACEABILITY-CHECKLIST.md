# Traceability Ledger

This ledger records implementation maturity; it is not a binary feature list. A type, class, fixture, or settings panel proves only that a surface is declared or partially implemented.

## Maturity states

| State         | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| Missing       | No adequate implementation exists.                                                        |
| Declared      | A requirement, contract, or schema exists.                                                |
| Isolated      | A primitive exists but the production composition does not reach it.                      |
| Partial       | A production path exists but violates required behavior or coverage.                      |
| Composed      | The complete behavior is reachable in production but required verification is incomplete. |
| Verified      | Focused and production-path checks pass with current evidence.                            |
| Cutover-ready | Real-host, security, platform, rollout, and rollback gates pass.                          |

Every row has a stable ID. `10-REMAINING-WORK-PLAN.md` owns executable work packages and detailed ownership. Source RFC documents remain normative for scope, schemas, and release gates.

## 2026-08-28 audit snapshot

The exhaustive parity and ecosystem pass classified all 108 source feature IDs: 20 verified,
14 composed, 48 implemented, 26 declared, and zero cutover-ready. The parity
result contains zero proven cross-host matches because the 14 canonical scenarios
still use identical synthetic handlers instead of real Pi and native production
adapters. The full receipt, integrated corrections, and remaining gates are in
[`prompt-audit-2026-08-28.md`](pi-coding-agent-removal/evidence/prompt-audit-2026-08-28.md),
and the eight added requirements are justified in
[`coding-agent-landscape-2026-08-28.md`](pi-coding-agent-removal/evidence/coding-agent-landscape-2026-08-28.md).

The later production-adapter runner is intentionally tracked separately from that
historical classification. Its current result is **0 matched, 1 divergent, and 13
unsupported** scenarios. Runnable adapters therefore exist, but the matrix proves
no cross-host parity and does not advance any requirement to Cutover-ready.

## Documentation and architecture decisions

| ID         | Requirement                                                                                     | Current maturity | Owning work | Evidence required to advance                                    |
| ---------- | ----------------------------------------------------------------------------------------------- | ---------------- | ----------- | --------------------------------------------------------------- |
| REQ-DOC-01 | One authority rule connects root refinements to source RFC owners.                              | Composed         | DOC         | Link/style check and independent conflict review.               |
| REQ-DOC-02 | Phases, RFC steps, stages, feature IDs, and receipts map without conflicting order.             | Composed         | DOC         | Final mapping review against steps, stages, and status.         |
| REQ-DOC-03 | Status distinguishes candidate prework from stage entry/exit state.                             | Composed         | DOC         | Final status/readiness contradiction scan.                      |
| REQ-DOC-04 | Readiness, resources, and paths describe the current tree; historical evidence stays immutable. | Composed         | DOC         | Current-path/link check and immutable-evidence review.          |
| REQ-ADR-01 | Runtime/provider ownership resolves retained `pi-agent-core` versus the native kernel.          | Missing          | ADR         | Accepted RFC/ADR update with dependency consequences.           |
| REQ-ADR-02 | One external tool facade owns version, schemas, effects, cancellation, and receipts.            | Missing          | ADR         | Accepted interface and production adapter spike.                |
| REQ-ADR-03 | Core owns a composite `EffectSet`; adapters cannot infer lower risk.                            | Partial          | ADR         | Core and native use a canonical non-empty set with duplicate/empty/unknown-effect tests; authoritative upstream metadata and lock-target derivation remain. |
| REQ-ADR-04 | Real-host conformance integration has a cycle-free package home.                                | Declared         | ADR         | Accepted graph and runnable production adapter pair.            |
| REQ-ADR-05 | Canonical runtime API explicitly supersedes stale RFC signatures.                               | Missing          | ADR         | Schema/RFC delta and adapter conformance.                       |
| REQ-ADR-06 | Core receives ambient capabilities through ports, not host globals.                             | Partial          | ADR         | Runtime cwd and clock are injected and core has no `process.cwd()` call; identity, timer, randomness, scheduling, and cancellation capability coverage remains incomplete. |
| REQ-ADR-07 | One settings service lifecycle is shared by native and Pi.                                      | Declared         | ADR         | Accepted composition root and cross-host snapshot test.         |
| REQ-ADR-08 | Policy receipts and the shared effect ledger have durable identity/recovery semantics.          | Partial          | ADR         | Versioned receipts, exact receipt mismatch detection, native persistence, and replay denial pass focused tests; expiry, revision, crash, and cross-host recovery semantics remain. |

## Runtime, models, tools, and transports

| ID         | Requirement                                                                             | Current maturity | Owning work | Evidence required to advance                                   |
| ---------- | --------------------------------------------------------------------------------------- | ---------------- | ----------- | -------------------------------------------------------------- |
| REQ-RUN-01 | Runtime scopes join all turn/request/tool/hook/plugin/persistence/transport work.       | Partial          | RUN         | Stop-during-turn and child-leak production tests.              |
| REQ-RUN-02 | Runtime and turns emit exactly one legal terminal sequence.                             | Partial          | RUN         | State, listener, persistence, and signal traces.               |
| REQ-RUN-03 | Steering and follow-up operate during streaming.                                        | Partial          | RUN         | Core same-turn safe-point steering, effect non-replay, and FIFO follow-up tests pass; add built interactive and RPC streaming scenarios. |
| REQ-RUN-04 | Active cancellation propagates; idle cancellation cannot affect the next turn.          | Partial          | RUN         | Idle/active/provider/tool/process suite.                       |
| REQ-RUN-05 | Startup composes immutable mode, trust, settings, model, session, prompt, and UI ports. | Partial          | RUN         | Complete composition snapshot and restart tests.               |
| REQ-RUN-06 | Prompt assembly includes trusted fragments and exact resumed history.                   | Composed         | RUN         | Uninterrupted-versus-resumed request equality.                 |
| REQ-RUN-07 | Provider/model/thinking selection is catalog-validated and observable.                  | Composed         | RUN         | Effective source precedence, atomic selection, and runtime validation pass; credentialed capability matrix remains. |
| REQ-RUN-08 | Streams, tool calls, stop reasons, errors, usage, and retries normalize strictly.       | Partial          | RUN         | Runtime-owned safe retry and attempt lifecycle pass; byte-split, rate-limit, and credentialed usage matrix remain. |
| REQ-RUN-09 | Tool preparation and schema validation precede every effect.                            | Partial          | RUN         | Core validates model inputs before admission; the native Octocode facade rejects malformed catalogs, non-JSON execution data, and schema-invalid outputs. Complete tool-class and real-path proof remains. |
| REQ-RUN-10 | Tool classification represents actual composite effects.                                | Partial          | ADR/RUN     | Core and native preserve composite effects, including clone network/process/write; the external catalog omits authoritative effects and lock targets. |
| REQ-RUN-11 | One boundary orders hooks, trust, policy, plan, locks, approval, ledger, and execution. | Partial          | RUN/EXT     | Durable native effect admission and focused policy traces pass; complete composite-effect ordering matrix remains. |
| REQ-RUN-12 | No transport, plugin, hook, retry, resume, or helper bypasses the boundary.             | Partial          | RUN/CONF    | Runtime retry and resume share the effect boundary; static guard and complete negative integration matrix remain. |
| REQ-RUN-13 | Print/JSON/RPC subscribe before start and through stopped.                              | Composed         | RUN         | Production lifecycle trace per mode.                           |
| REQ-RUN-14 | RPC has command schemas, correlated outer failures, and concurrent dispatch.            | Partial          | RUN         | Concurrent cancel passes; frame bounds, backpressure, broken-pipe, and built-client corpus remain. |
| REQ-RUN-15 | Headless stdout/stderr and exit codes remain protocol-pure.                             | Composed         | RUN         | Built RPC signal trace and transport tests pass; reproduce the full failure matrix from the clean candidate. |
| REQ-RUN-16 | Responses is the canonical OpenAI transport, including reasoning, hosted/MCP tools, approvals, tool search, and persisted response state. | Partial | RUN | Typed Responses streaming and cache telemetry pass; hosted tools, persisted state, and approved live-provider corpus remain. |
| REQ-RUN-17 | Every retained provider protocol has an explicit native adapter or approved retirement. | Partial | RUN/ADR | OpenAI Chat, Responses, and Anthropic adapters pass focused tests; complete provider/model/thinking/auth/retry and retirement matrix remains. |
| REQ-RUN-18 | The full file, shell, web, browser, media, local-server, call-tool, memory, and coordination palette is native with truthful composite effects. | Missing | RUN | Per-tool parity and real-path security matrix. |
| REQ-RUN-19 | MCP uses a persistent catalog and implements declared auth, sampling, elicitation, roots, progress, subscriptions, and approval flows. | Partial | RUN | Persistent stdio/HTTP, OAuth, consent, crash/restart, and redaction corpus. |
| REQ-RUN-20 | Skills support native discovery, provenance, budgets, refresh, usage, context registration, and authorized lifecycle operations. | Composed | RUN | Containment, refresh, lifecycle, settings enablement, and provenance pass locally; add resumed-session and clean cross-host corpus. |
| REQ-RUN-21 | Context assembly is budgeted, deduplicated, cache-friendly, provenance-rich, and observable. | Partial | RUN | Stable prompt/catalog prefixes, environment-complete catalog cache keys, and per-result plus aggregate turn bounds pass; add whole-context token budgets, truncation corpus, and cache-hit telemetry. |
| REQ-RUN-22 | Hierarchical AGENTS/Skills/MCP/config discovery has explicit trust, precedence, refresh, and provenance. | Declared | RUN | Nested-source conflict, deduplication, untrusted-workspace, refresh, and resumed-provenance corpus. |
| REQ-RUN-23 | Model fallback/routing is catalog-validated, policy-controlled, consent-aware, scoped, and observable. | Declared | RUN/SET | Failure/rate/cost/capability matrix with no silent capability downgrade. |
| REQ-RUN-24 | Tool schemas can be discovered and loaded on demand without expanding capability or bypassing policy. | Declared | RUN | Ranking, bounds, stale-catalog, hidden-tool, duplicate, and privilege-escalation corpus. |
| REQ-RUN-25 | AST/LSP semantic context maps are token-budgeted, fresh, source-linked, and resilient to missing language servers. | Declared | RUN | Multi-language symbol/reference/call graph fixtures, stale-index tests, and bounded fallback. |
| REQ-RUN-26 | ACP maps editor sessions, modes, permissions, progress, filesystem, terminal, and MCP into canonical ports. | Declared | RUN/ORCH | Pinned ACP schema/conformance suite against at least two independent clients. |
| REQ-RUN-27 | MCP durable tasks are version-negotiated, auth-bound, cancellable, recoverable, bounded, and auditable. | Partial | RUN | Strict records, corruption preservation, bounded stale-lock recovery, private atomic replacement, and a 12-process writer fixture pass; add pinned auth, TTL, restart, and cross-caller isolation fixtures. |

## Sessions and compaction

| ID         | Requirement                                                                | Current maturity | Owning work | Evidence required to advance                       |
| ---------- | -------------------------------------------------------------------------- | ---------------- | ----------- | -------------------------------------------------- |
| REQ-SES-01 | Resume/continue restore exact model-visible context.                       | Composed         | SES         | Restart/resume provider-request equality.          |
| REQ-SES-02 | Full session command set is production-reachable.                          | Partial          | SES         | The durable launcher composes create, resume, switch, fork, name, export, and previous/next/parent/child navigation through replacement fixed-session runtimes; import and the complete real CLI/RPC matrix remain. |
| REQ-SES-03 | `--no-session` performs no durable write.                                  | Composed         | SES         | Whole-home before/after test.                      |
| REQ-SES-04 | Filesystem commit is linearizable across processes.                        | Partial          | SES         | Multi-process writer stress receipt.               |
| REQ-SES-05 | Missing/corrupt primary recovery uses backup and cleans temporary state.   | Partial          | SES         | Explicit resume and terminal continuation recover valid backups; add the complete crash/temporary-state corpus. |
| REQ-SES-06 | Envelopes, events, branches, leaves, and references validate semantically. | Partial          | SES         | Property and corruption corpus.                    |
| REQ-SES-07 | Fork repairs all event/branch/parent/retained references.                  | Partial          | SES         | Focused parent, branch, compaction, and retained-reference repair passes; add graph property tests and replay equality. |
| REQ-SES-08 | Migration is stable, transactional, retryable, and byte-preserving.        | Partial          | SES         | Changing-source rollback and malformed-line tests. |
| REQ-SES-09 | Partial visible output survives the defined crash boundary.                | Partial          | SES         | Abrupt termination and restart receipt.            |
| REQ-SES-10 | Compaction is composed, durable, cancellable, bounded, and retry-limited.  | Partial          | SES         | Manual and threshold compaction, cancellation, bounded failure handling, restart recovery, correlation-closed retained context, and built-RPC execution pass; overflow and the crash matrix remain. |

## Agents, messaging, and flow control

| ID | Requirement | Current maturity | Owning work | Evidence required to advance |
|---|---|---|---|---|
| REQ-ORCH-01 | A native worker supervisor owns spawn, capability limits, state, handback, crash cleanup, and structured shutdown. | Verified | ORCH | Real owned-orphan process recovery and open-handle cleanup pass; reproduce from the clean candidate and supported platforms. |
| REQ-ORCH-02 | Worker packets and ledgers are typed, correlated, durable, redacted, and session-linked. | Partial | ORCH | Approval/session/capability-bound JSONL projection and recovery pass; complete durable restart reconciliation across transports. |
| REQ-ORCH-03 | Send, steer, follow-up, list/status, wait, abort, and kill preserve queue and liveness semantics. | Partial | ORCH | Persistent RPC adapter, real process recovery, and controller scenarios pass; complete the full dead-pipe, backpressure, and escalation matrix. |
| REQ-ORCH-04 | Session-to-session and worker messaging uses durable addressing, read/ack cursors, handoff, provenance, and restart delivery. | Partial | ORCH | Native inbound outbox bridge, ordered ack, replay dedupe, and real-SQLite handoff pass; add the two-process worker/mailbox crash corpus. |
| REQ-ORCH-05 | Awareness remains the authority for plans, tasks, agents, work, locks, checks, messages, handoffs, outbox, and verified memory. | Partial | ORCH | Shared Awareness consumer now serves Pi and native adapters without a second mailbox; complete the full coordination-port and worker-authority proof. |
| REQ-ORCH-06 | Dependency-ready work runs with bounded parallelism, atomic claims, leases, path ownership, and deterministic reconciliation. | Missing | ORCH | DAG race, overlap, expiry, and recovery matrix. |
| REQ-ORCH-07 | Worktree create, refresh, retain, merge, discard, and recovery fail closed on dirty, conflict, crash, or unmerged state. | Missing | ORCH | Worktree lifecycle and crash/restart corpus. |
| REQ-ORCH-08 | Editor and RPC surfaces project worker/session state and controls without bypassing runtime policy. | Composed | ORCH/TUI | Dynamic session/approval-bound RPC/ACP projection and official ACP permission requests pass locally; clean independent-client and zero-bypass conformance remain open. |

## Hooks and plugins

| ID         | Requirement                                                                    | Current maturity | Owning work | Evidence required to advance                    |
| ---------- | ------------------------------------------------------------------------------ | ---------------- | ----------- | ----------------------------------------------- |
| REQ-EXT-01 | All managed/user/workspace/session/inline/plugin hook sources are discovered.  | Partial          | EXT         | Source precedence and trust corpus.             |
| REQ-EXT-02 | Exact-hash review gates every non-managed hook.                                | Partial          | EXT         | Changed-hash and untrusted-workspace tests.     |
| REQ-EXT-03 | Command and synchronous MCP handlers execute correctly.                        | Composed         | EXT         | Command execution and the registry-owned production MCP hook executor pass; add pinned official-format and clean cross-host fixtures. |
| REQ-EXT-04 | Hook decisions, timeouts, failures, and cancellation are deterministic.        | Partial          | EXT         | Command and MCP executor decisions, timeout/cancel behavior, and lifecycle dispatch pass; complete fault and native/Pi conformance. |
| REQ-EXT-05 | Async hook work is bounded, owned, drained, and redacted.                      | Composed         | EXT         | Async work does not block or rewrite the triggering effect and drains or cancels during shutdown; reproduce through the clean security/conformance matrix. |
| REQ-EXT-06 | Blocking hooks govern effects and revalidate after rewrite.                    | Partial          | EXT/RUN     | Command/MCP blocking decisions are composed; add complete composite-effect rewrite/revalidation and clean zero-bypass proof. |
| REQ-EXT-07 | Plugin discovery and activation are production-composed.                       | Verified         | EXT         | Default filesystem discovery and a real plugin activation/unload fixture pass; reproduce from the clean candidate. |
| REQ-EXT-08 | Grants bind identity, manifest hash, revision, scope, permissions, and expiry. | Partial          | EXT         | Grant mismatch/expiry corpus.                   |
| REQ-EXT-09 | Contributions are declared, authorized, owner-correct, and transactional.      | Partial          | EXT         | Spoof/undeclared/rollback tests.                |
| REQ-EXT-10 | Plugin paths pass normalized realpath containment.                             | Partial          | EXT         | Traversal and symlink tests.                    |
| REQ-EXT-11 | Update preserves old state on failure; unload proves zero leases/residue.      | Partial          | EXT         | Transactional rollback and lease-safe unload pass; add update/restart/fault/leak matrix. |
| REQ-EXT-12 | The frozen Pi oracle projects tool/command registration through canonical registries until deletion. | Partial | EXT | Oracle inventory and composition comparison. |

## Settings and TUI

| ID         | Requirement                                                                       | Current maturity | Owning work | Evidence required to advance              |
| ---------- | --------------------------------------------------------------------------------- | ---------------- | ----------- | ----------------------------------------- |
| REQ-SET-01 | Native CLI/runtime/browser use one settings service; the frozen Pi oracle projects it during comparison. | Composed | SET | Native runtime, browser actions, and legacy native writers use the transactional service; add temporary cross-host snapshot conformance. |
| REQ-SET-02 | Native `/settings` and deep links are production-reachable.                       | Verified         | SET         | Real launcher/browser save, focus/ARIA, provider visibility, and mobile-width checks pass. |
| REQ-SET-03 | Every projection, diff, error, diagnostic, and CLI output redacts secrets.        | Partial          | SET         | Secret-shaped legacy-key corpus.          |
| REQ-SET-04 | Mutations require revisions and return typed conflicts.                           | Composed         | SET         | Review, unreview, grant, revoke, model, and appearance mutations are revision checked; reproduce concurrent edits through clean browser/runtime composition. |
| REQ-SET-05 | Scope, provenance, diff, impact, rollback, and recovery are atomic/visible.       | Partial          | SET         | Mutation/recovery suite.                  |
| REQ-SET-06 | Model selection resolves through the effective catalog.                           | Partial          | SET         | Unknown/default/custom source matrix.     |
| REQ-SET-07 | Models/Hooks/Plugins/MCP/Skills panels implement required controls.               | Partial          | SET         | Plugin/hash review and capability grant/revoke actions pass; complete the remaining section action suite. |
| REQ-SET-08 | Workspace mutations fail closed without positive trust.                           | Composed         | SET         | Review/grant mutations enforce trust, identity, hash, capability, revision, and redaction checks; reproduce through the clean browser/security matrix. |
| REQ-SET-09 | CSP, origin, token, size, containment, and no-store controls pass.                | Partial          | SET         | Native/Pi browser security matrix.        |
| REQ-TUI-01 | OpenTUI loads dynamically only in interactive mode.                               | Composed         | TUI         | Built-artifact module/FFI isolation test. |
| REQ-TUI-02 | One OpenTUI editor owns input, focus, keys, mouse, resize, and paste.             | Partial          | TUI         | Mouse, paste, resize, and real PTY integration tests. |
| REQ-TUI-03 | Select, confirm, approval, steer, follow-up, and cancel work.                     | Partial          | TUI         | Streaming-control and `UiPort` interaction corpus. |
| REQ-TUI-04 | Thinking/tools/progress/results/errors/widgets/header/footer render semantically. | Composed         | TUI         | Reducer, frame, and accessibility tests.  |
| REQ-TUI-05 | Streaming is queued, bounded, and coalesced without loss.                         | Partial          | TUI         | Sustained-stream receipt.                 |
| REQ-TUI-06 | Signals and all failure paths restore the terminal.                               | Partial          | TUI         | One real macOS/Node 26 exact-restoration PTY pass exists; complete fault-injected supported-platform matrix. |
| REQ-TUI-07 | Unicode, accessibility, capability, artifact, and platform suites pass.           | Missing          | TUI         | Supported-platform receipt.               |
| REQ-TUI-08 | Diff/checkpoint history supports accessible compare plus independent file, conversation, and combined restore. | Declared | TUI/SES | Conflict, storage-bound, restore-mode, restart, keyboard, alternate-output, and editor projection corpus. |

## Conformance, rollout, and complete Pi retirement

| ID          | Requirement                                                                    | Current maturity | Owning work | Evidence required to advance                |
| ----------- | ------------------------------------------------------------------------------ | ---------------- | ----------- | ------------------------------------------- |
| REQ-CONF-01 | Scenarios invoke real Pi/native production adapters.                           | Partial          | CONF        | The production-adapter runner reports 0 matched, 1 divergent, and 13 unsupported scenarios; implement the unsupported host paths and rerun the full corpus. |
| REQ-CONF-02 | Normalization preserves correlation, ancestry, ordering, and meaningful paths. | Partial          | CONF        | Identity/metamorphic tests.                 |
| REQ-CONF-03 | One cross-host ledger prevents duplicate/unregistered effects.                 | Partial          | CONF        | Pure/shadow/live negative tests.            |
| REQ-CONF-04 | Every phase adds real-host scenarios.                                          | Missing          | CONF        | Phase receipts linked from the plan.        |
| REQ-CONF-05 | Security bypass tests cover all entry routes.                                  | Missing          | CONF        | Complete zero-bypass matrix.                |
| REQ-REL-01  | Shadow thresholds pass without unregistered effects.                           | Missing          | REL         | Signed shadow receipt.                      |
| REQ-REL-02  | Canary thresholds and observation window pass.                                 | Missing          | REL         | Cohort metrics and decision.                |
| REQ-REL-03  | Release-artifact rollback preserves durable sessions.                          | Missing          | REL         | Rehearsal receipt.                          |
| REQ-REL-04  | Native default gates pass on every supported platform.                         | Missing          | REL         | Packaging/mode/PTY/security receipts.       |
| REQ-REL-05  | Complete Pi package/dependency/product-path removal waits for all gates.        | Partial          | REL         | Post-rollout repository and packed-artifact zero-reference proof. |
| REQ-REL-06  | `@octocodeai/pi-extension` is a temporary frozen oracle and is deleted after native-only rollback and migration gates pass. | Missing | REL | Signed oracle freeze and final deletion receipts. |
| REQ-REL-07  | Clean install and supported upgrade pass after native removal.                 | Missing          | REL         | Release install/upgrade matrix.             |

## Advancement rule

A row advances only when its work package records the source requirement, accepted architecture, production path, focused and production-path tests, package verification, applicable real-path receipt, and no unresolved stop gate.

Only `Cutover-ready` rows may support native-default or native Pi-dependency-removal claims.
