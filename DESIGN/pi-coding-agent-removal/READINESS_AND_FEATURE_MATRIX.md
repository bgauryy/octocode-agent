# Implementation readiness and feature matrix

> Scope owner: `RFC.md`. Current progress: `STATUS.md`. Execution order: `STEPS.md`. Detailed implementation: `IMPLEMENTATION.md`. Hooks/plugins: `HOOKS_AND_PLUGINS.md`. Required tests and gates: `TEST_PLAN.md` and `KPI.md`.

## Executive rating

The project has a **substantial dirty-tree native implementation candidate**, but it is not release-proven. The native editor foundation is usable for continued implementation and verification; the Pi-retirement program is not ready for canary or deletion.

| Rating | Score | Meaning |
|---|---:|---|
| RFC/design completeness | **9/10** | Boundaries, stages, schemas, risks, tests, measurements, rollback, OpenTUI, settings/models, hooks, plugins, orchestration, and final Pi deletion are reconciled; canonical release evidence remains. |
| Native-editor implementation readiness | **8.5/10** | The production candidate includes governed runtime composition, composite effect admission with durable native receipts, OpenAI Chat/Responses and Anthropic adapters, a production session router with parent/child navigation and bounded automatic compaction, MCP/Skill lifecycle and controls, worker recovery with RPC/ACP projection, command/MCP/async hooks, trust-gated plugins, semantic OpenTUI, protected settings, and 3,484 passing root tests. Credentialed providers, session import and the complete corruption corpus, authoritative upstream tool metadata, clean packaging, and cross-platform proof remain. |
| Native canary readiness | **2/10** | Real native paths and local effect-ledger proof exist, but the migration selector, matching real Pi/native conformance, shared cross-host effect proof, platform/package matrices, thresholds, and rollback rehearsal are absent. |
| Pi-retirement readiness | **2/10** | The native launcher is already Pi-free at its direct surface and the end state is approved, but Pi remains a live package and transitive path; no bounded selector/oracle freeze, observation receipt, prior-native rollback, clean install/upgrade, or final zero-reference proof exists. |
| Weighted cutover readiness | **5/10** | Evidence-weighted combination of design, implemented native seams, production composition, verification, migration controls, and release proof. This is not a schedule estimate or permission to delete Pi. |

The correct decision is **continue the dependency-ordered native implementation while the release remains HOLD**, not “start deleting Pi.” Freeze the Pi oracle and build the migration selector before canary; delete both only after native-only rollback and the final retirement gates pass.

### Exhaustive audit receipt

The 2026-08-28 sequential architecture, context-efficiency, Pi-parity, and ecosystem audits
classified all 108 stable IDs in this file. Maturity is 20 verified, 14 composed,
48 implemented, 26 declared, and 0 cutover-ready. Parity is 4 approved
differences, 1 native superset, 13 unproven, 23 partial, 2 mismatches, 63 missing,
2 holds, and 0 proven matches. The zero-match result is intentional and
evidence-based: the conformance harness still compares identical synthetic
handlers rather than real Pi and native production adapters.

See [`evidence/prompt-audit-2026-08-28.md`](evidence/prompt-audit-2026-08-28.md)
for the fixes, verification receipts, and release gates. These counts do not
replace the stable requirements below and do not authorize Pi deletion.

Those counts are a dated audit snapshot. Later dirty-tree increments are reflected in the current rating and subsystem rows, but the historical 108-ID classification is not silently recalculated. A new exhaustive audit receipt is required before its counts change.

The 2026-08-28 production-adapter runner reports **0 matched, 1 divergent,
and 13 unsupported** scenarios. This result supersedes neither the dated 108-ID
classification nor its zero-match verdict; it shows that runnable adapters exist
while production parity remains unproven.

## Maturity scoring

Each implementation area uses this maturity scale:

| Level | Meaning | Required evidence |
|---:|---|---|
| 0 | Absent | No target code or executable proof |
| 1 | Inventoried/specification only | Source anchors and approved contract or RFC |
| 2 | Prototype or reusable current seam | Focused tests, but not wired as the target production path |
| 3 | Implemented behind adapter/flag | Target module builds and passes unit/contract tests |
| 4 | Host-conformant candidate | Shared Pi/native matrix, faults, security, and performance pass |
| 5 | Release-proven | Canary, observation window, rollback rehearsal, and artifact checks pass |

Scores come from repository evidence, not confidence language. A document cannot raise implementation maturity above Level 1. A proof adapter without a production caller cannot exceed Level 2. A feature cannot reach Level 4 without the mandatory shared suite.

## Readiness by subsystem

| Subsystem | Maturity | Existing evidence | Missing before next maturity level | Primary gate |
|---|---:|---|---|---|
| Canonical baseline | 1/5 | AST/LSP working-tree inventory and focused test receipts | Named clean commit, exact commands, raw/normalized hashes, approved incidental-field classification | `PREREQUISITES.md` baseline receipt |
| Agent-core package boundary | 3/5 | Host-neutral package, contracts, kernel, and boundary tests exist | Public API/dependency review plus production reachability for every declared service | Step 3 |
| Runtime contracts and schemas | 3/5 | Discriminated contracts, schemas, validators, runtime tests, worker RPC/ACP envelopes, provider adapters, and MCP/Skill/hook composition exist | Close durable graph/effect, complete fault/security, clean settings, and cross-host editor gaps | Schema/type suite |
| Pi compatibility adapter | 3/5 | Pi extension consumes agent-core seams and its package suite passes | Freeze the exact oracle artifact/version and bind it to the real shared conformance runner | Host-conformance suite |
| Lifecycle/event bus | 3/5 | Canonical lifecycle bus and runtime events exist | Map every used Pi listener and compose blocking hooks/plugins in production | Event golden suite |
| Tool/command registries | 3/5 | Native Octocode tools use canonical composite effect sets; the facade validates catalog identity/count, schemas, JSON output, cancellation, and typed redacted failures | Pin the production facade, move effects/output/lock targets to authoritative upstream metadata, complete the direct palette and command inventory, and prove real-host parity | Registry snapshots |
| Security/policy kernel | 3/5 | Native policy, trust, approval, plan, cancellation, composite admission receipts, altered-receipt denial, and persistent effect state pass focused tests | Complete peer-lock targets, expiry/revision/crash semantics, one cross-host effect ledger, and the zero-bypass matrix | Zero-bypass guardrail |
| Native sessions/import | 3/5 | Native durable store plus production create/resume/switch/fork/name/export and previous/next/parent/child navigation exist | Import and the corruption/restart/migration corpus | Session migration suite |
| Prompt/compaction | 3/5 | Manual and threshold compaction are production-composed, persisted, cancellable, and retry-bounded | Prove overflow, crash recovery, retained-reference validity, and the complete provider/context corpus | Prompt/compaction corpus |
| Native model/tool loop | 3/5 | OpenAI Chat, Responses, and Anthropic adapters share the bounded native loop with streaming, tools, cancellation, cache telemetry, and transport tests | Run credentialed real-provider/fault/performance suites and close complete tool/MCP/Skill behavior | Deterministic turn suite |
| Interactive OpenTUI | 3/5 | Native adapter, controller, renderer, input path, semantic widgets, focused tests, and one real macOS PTY restoration smoke pass exist | Pass canonical package, accessibility, restoration, alternate-input/output, and supported-platform matrices | OpenTUI acceptance |
| Print/JSON/RPC | 3/5 | Native adapters, versioned RPC schemas, malformed-input/cancellation tests, persistent worker control, and approval/session-bound dynamic RPC/ACP worker projection exist | Complete the fault/backpressure corpus and clean independent-client lifecycle proof | Mode matrix |
| Unified settings HTML | 3/5 | One native registry/service/page owns revision-safe storage and protected browser actions; provider, MCP, Skill, plugin review/grant, portable export/import/reset, focus/ARIA, and mobile-width checks pass | Complete remaining writers and recovery plus packaged-browser and native/Pi conformance | Settings completeness suite |
| Models/`models.json` | 2/5 | Native model selection/storage and protocol reporting exist | Effective catalog, precedence/import, provider/model CRUD, safe revisions, backup, conflict, and recovery | Models suite |
| Codex hooks compatibility | 3/5 | Native filesystem discovery, review/hash checks, command/MCP execution, bounded asynchronous ownership, lifecycle dispatch, and blocking decisions are production-composed | Add pinned official fixtures, the complete fault matrix, and cross-host health/conformance proof | Codex compatibility suite |
| Event-driven plugins | 3/5 | Native discovery, explicit grants, transactional activation/rollback, owner isolation, leases, unload, a real filesystem fixture, and review/grant settings actions pass | Complete formal capability approval, broader fixtures, update/restart, and clean security proof | Plugin lifecycle suite |
| Shared test harness | 2/5 | Normalized scenarios and effect-ledger structures exist | Bind real frozen-Pi and native hosts; prove first divergence, faults, security, effects, and performance | Complete shared corpus |
| Observability/evidence | 1/5 | Receipt schemas and KPI definitions | Runtime trace implementation, privacy review, dashboards/queries, before/after raw receipts | KPI receipt |
| Canary/rollback/release | 1/5 | Staged policy, temporary-oracle decision, and native-only final rollback rule exist | Implement the migration selector, freeze the oracle, set thresholds, rehearse Pi-window and prior-native rollback, observe, install/upgrade, then delete Pi | Stages 6–7 |

## Critical blockers

These items block implementation maturity above Level 1 or 2:

1. Select and record the canonical before commit; the inspected tree is dirty and cannot be the release baseline implicitly.
2. Assign runtime, session, security, extensions, terminal, settings/models, testing, and release owners.
3. Close the remaining agent-core contracts and prove production reachability without host-specific leakage.
4. Decide the native session encoding/store after running the required prototype and corruption corpus.
5. Freeze the temporary Pi oracle artifact/version and pin the Codex hook compatibility version/fixture snapshot.
6. Approve the plugin capability/trust policy, especially process, filesystem, network, MCP, model, secret, and UI grants.
7. Select and prove the OpenTUI runtime/native-package route on every supported release platform.
8. Implement the release-owned migration selector, then set quantitative canary thresholds and the observation window before native becomes default.

None of these blockers justify bypassing Stage 0. They are the output of Stage 0 and early Stage 1.

## Complete target feature inventory

The IDs below are stable traceability identifiers for implementation issues and evidence receipts.

### Runtime and architecture

| ID | Feature | Required outcome |
|---|---|---|
| R-01 | Agent-core package | One owner for runtime contracts, schemas, kernel, sessions, events, settings, models, hooks, and plugins |
| R-02 | One composition root | Native launcher composes explicit ports; no dynamic Pi SDK shape in native product code |
| R-03 | Capability-focused APIs | Tools/events cannot access command-only or unrelated host privileges |
| R-04 | Versioned commands/events | Discriminated, exhaustively handled contracts with runtime validation |
| R-05 | Lifecycle state machine | Legal start/turn/tool/stop transitions and exactly one terminal state |
| R-06 | Ordered middleware | Stable priority/source/declaration ordering, transforms, blocking, timeouts, and attribution |
| R-07 | Structured cancellation | One `AbortSignal` ownership tree with child process/task cleanup |
| R-08 | Typed errors | Stable categories, safe causes, adapter mapping, and protocol errors |
| R-09 | Model port | Provider-neutral request, stream, usage, retry, stop, and failure normalization |
| R-10 | Prompt pipeline | Pure ordered segments, provenance, token accounting, and snapshot comparison |
| R-11 | Policy kernel | Trust, approval, plan mode, effect class, and peer-lock checks before effects |
| R-12 | Observability | Correlated redacted event/effect/decision/session receipts and bounded metrics |
| R-13 | Context governance | Token budgets, cache-friendly stable prefixes, deduplication, truncation policy, provenance, and context-cost telemetry |
| R-14 | Instruction/config discovery | Hierarchical `AGENTS.md`, Skills, MCP, managed/user/workspace/session sources with trust, precedence, deduplication, refresh, and provenance |
| R-15 | Model routing and fallback | Catalog-validated health/rate/cost policy, explicit consent rules, per-turn/session scope, provenance, and deterministic fallback without silent capability loss |

### Tools, commands, resources, and transports

| ID | Feature | Required outcome |
|---|---|---|
| T-01 | Tool registry | Canonical names, schemas, metadata, active defaults, duplicate detection, and deterministic inventory |
| T-02 | Tool execution | Validated input, updates, results, cancellation, policy, and persistence ordering |
| T-03 | Command registry | Names, descriptions, completion, context capabilities, shortcuts, and discovery |
| T-04 | Resource registry | Skills, prompt resources, and assets with provenance and containment |
| T-05 | MCP catalog/port | Connected-server inventory and validated tool execution independent of host |
| T-06 | Interactive transport | Native runtime input, streaming, commands, sessions, approval, and cancellation |
| T-07 | Print transport | Deterministic stdout/stderr and exit codes without terminal UI initialization |
| T-08 | JSON transport | Versioned machine-readable commands/events and protocol-pure stdout |
| T-09 | RPC transport | Correlated requests/responses/events, version rejection, bounds, and malformed-frame recovery |
| T-10 | SDK/embed boundary | In-process typed composition without exposing private runtime implementation |
| T-11 | Pure shadow mode | Compare deterministic behavior without duplicate model calls, writes, messages, or effects |
| T-12 | Migration host selector | Release-composed `pi|shadow|native` selection, per-session host/oracle identity, one writable host, and explicit rollback; absent from the current native launcher and deleted with Pi |
| T-13 | ACP interoperability | Version-pinned ACP agent endpoint with initialize/auth, new/list/resume/close/fork, prompt/cancel, modes/config, progress, permission, terminal/filesystem, MCP, and generated schema conformance |
| T-14 | Dynamic tool discovery | Searchable deferred tool schemas, capability/policy filtering, deterministic ranking, bounded result sets, and no hidden privilege expansion |
| T-15 | Semantic code context | Token-budgeted AST/LSP symbol, type, reference, caller/callee, and dependency map with freshness and exact source provenance |
| T-16 | MCP durable tasks | Version-negotiated task extension with authorization binding, secure IDs, bounded concurrency/TTL, polling/update/cancel, progress, recovery, and audit logging |

### Sessions, persistence, and context

| ID | Feature | Required outcome |
|---|---|---|
| S-01 | Stable session identity | IDs, names, selected host, model metadata, and provenance |
| S-02 | Append-only native store | Versioned events, optimistic revisions, atomic commits, and deterministic replay |
| S-03 | Pi import | Read-only source, separate native destination, checksums, and explicit conversion |
| S-04 | Resume/switch | Deterministic projection and host-safe continuation |
| S-05 | Branch/fork/tree | Parent graph, selected leaf, labels where approved, and navigation |
| S-06 | Rewind/checkpoints | Proven leaf lookup, filesystem checkpoint ownership, and explicit recovery |
| S-07 | Durable custom entries | Persistence without accidental model-context inclusion |
| S-08 | Compaction state machine | Manual, threshold, overflow, retry, failure, cancellation, and one terminal result |
| S-09 | Crash/corruption recovery | Truncated, malformed, stale, duplicate, interrupted, and unknown-version handling |
| S-10 | Export/diagnostics | Stable safe export without deep Pi imports or private-content leakage |

### Hooks and events

| ID | Feature | Required outcome |
|---|---|---|
| H-01 | Canonical event envelope | Version, identity, phase, session/turn, parent, mode, model, trust, and typed payload |
| H-02 | Current Pi listener mapping | Every production-used composed/direct listener mapped with approved semantics |
| H-03 | Codex event compatibility | Declared support for `PreToolUse`, `PermissionRequest`, `PostToolUse`, compaction, prompt, subagent, stop, and session events |
| H-04 | Codex JSON discovery | User, trusted project, managed, and plugin `hooks.json` sources |
| H-05 | Codex TOML discovery | Inline `[hooks]` configuration with source provenance |
| H-06 | Source merge | Additive matching definitions and deterministic source/declaration order |
| H-07 | Matchers | Exact/wildcard/regex-compatible event-specific subjects |
| H-08 | Command handlers | JSON stdin/output, platform command, bounded environment/output, timeout, cancellation, and descendant cleanup |
| H-09 | MCP-tool handlers | Connected server/tool, typed templates, validation, timeout, and no recursive hooks/approval |
| H-10 | Decision aggregation | Deny wins, limited allow bypass, rewrite composition/revalidation, context, stop, and suppression |
| H-11 | Asynchronous hooks | Nonblocking-only semantics, per-session cap, safe-point delivery, and shutdown cancellation |
| H-12 | Exact-definition trust | Review hash, changed-definition invalidation, managed-only policy, and enablement separate from trust |
| H-13 | Output safety | Schema validation, secret redaction, size limits, protected spill, and cleanup |
| H-14 | Hook observability | Definition/event identity, order, decision digest, timing, failures, spills, and redactions |

### Extensions and plugins

| ID | Feature | Required outcome |
|---|---|---|
| P-01 | Compatible package entry | Discover `.codex-plugin/plugin.json` and hook paths without repackaging |
| P-02 | Octocode manifest block | Versioned API, activation events, requested permissions, and contribution declarations |
| P-03 | Plugin catalog | Discovery, identity/version/hash, validation, enablement, compatibility, and health |
| P-04 | Capability grants | Deny-by-default process/filesystem/network/MCP/model/secret/UI/registry permissions |
| P-05 | Activation lifecycle | Discovered, validated, trust-required, enabled, activating, ready, deactivating, stopped, and failed |
| P-06 | Transactional activation | All contributions appear together or reverse-clean completely |
| P-07 | Deterministic conflicts | Namespacing or explicit failure; no silent last-writer-wins override |
| P-08 | Lazy activation | Allowlisted safe activation events and no mid-effect implementation swap |
| P-09 | Leases and unload | Active-operation tracking, wait/cancel/refuse policy, reverse cleanup, and zero leaks |
| P-10 | Update/resume provenance | Session records plugin version/hash and explains missing/changed behavior |
| P-11 | Hook contributions | Trusted event definitions through the canonical hook catalog |
| P-12 | Tool contributions | Namespaced schema/executor/policy registrations through `ToolRegistry` |
| P-13 | Command contributions | Context-scoped registrations and headless behavior through `CommandRegistry` |
| P-14 | Skill/resource contributions | Contained paths, provenance, validation, and size limits |
| P-15 | MCP contributions | Explicit process/network grants, validated definitions, and connection ownership |
| P-16 | Setting contributions | Schema, scope, provenance, redaction, owner, and required HTML rendering |
| P-17 | Prompt contributions | Named placement, trust, provenance, size limits, and snapshot review |
| P-18 | UI contributions | Semantic views/actions, accessibility metadata, and headless fallback without toolkit types |
| P-19 | Model/provider contributions | Separately granted high-risk adapter capability and credential-boundary review |

### Terminal and settings experience

| ID | Feature | Required outcome |
|---|---|---|
| U-01 | OpenTUI adapter | `@opentui/core` only under the native terminal boundary |
| U-02 | Immutable UI projection | Runtime/UI events reduce into testable presentation state |
| U-03 | Streaming renderer | Coalesced presentation updates without dropping semantic events |
| U-04 | Input/focus/resize | Keyboard navigation, focus, mouse where supported, resize, Unicode width, and narrow layouts |
| U-05 | Interactions | Confirm, select, input, editor, notifications, status, widgets, and capability fallback |
| U-06 | Accessibility | Visible focus, color-independent severity, keyboard-only use, and alternate output strategy |
| U-07 | Terminal restoration | Normal, error, cancel, signal, crash, and failed-initialization cleanup exactly once |
| U-08 | One settings page | `settings.html` is the only human-facing settings control center |
| U-09 | Settings registry | Complete definitions, stored/effective values, provenance, scope, revision, owner, and timing |
| U-10 | Models section | Effective catalog, default transaction, custom providers/models, compatibility, and unknown metadata |
| U-11 | `models.json` management | Source precedence, structured/advanced editing, diff, atomic writes, backup, conflict, recovery, and secret safety |
| U-12 | Hooks section | Sources, event/handler/matcher, review hash, trust, enablement, compatibility, test, and health |
| U-13 | Plugins section | Identity/version, API, activation, permissions, contributions, leases, update/unload, and health |
| U-14 | Protected local server | Loopback, origin/token/CSRF/body/path controls, CSP, no-store, and trust enforcement |
| U-15 | Accessibility/responsiveness | Keyboard, focus, screen-size, semantic labels, and safe error/recovery flows |
| U-16 | Change review and checkpoints | Per-effect diff/checkpoint timeline with separate file, conversation, and combined restore, conflict detection, storage bounds, and accessible TUI/editor projection |

### Agents, messaging, and orchestration

| ID | Feature | Required outcome |
|---|---|---|
| A-01 | Worker supervisor | Native structured worker lifecycle with bounded spawn, crash cleanup, shutdown ownership, and no orphaned processes |
| A-02 | Spawn packet and capability policy | Typed goal/context/scope/ownership/acceptance/return packets plus model/tool/path/resource limits |
| A-03 | Worker ledger and handback | Correlated durable state, progress, terminal reason, evidence, verification, confidence, and session linkage |
| A-04 | Worker message control | list/status/send/steer/follow-up preserve active-versus-idle and FIFO queue semantics |
| A-05 | Wait, abort, and kill | Progress-aware waiting, graceful abort, deterministic waiter resolution, and bounded termination escalation |
| A-06 | Session mailbox and handoff | Durable addressed send/read/ack, broadcast, handoff acceptance, provenance, redaction, expiry, and restart delivery |
| A-07 | Awareness-backed scheduler | Awareness-owned DAG/task claims, leases, messages, handoffs, locks, checks, work presence, and bounded parallel execution |
| A-08 | Worktree lifecycle | Approved create/refresh/retain/merge/discard/recovery that never silently loses dirty, conflicting, or unmerged work |

### Compatibility, verification, and release

| ID | Feature | Required outcome |
|---|---|---|
| Q-01 | Temporary Pi oracle | A frozen, named Pi artifact remains only until every accepted capability has native evidence or an approved retirement |
| Q-02 | Pi retirement | The extension package, live adapters, workspace/release wiring, dependencies, tests, and active product docs are deleted after the observation gate |
| Q-03 | Shared conformance corpus | Same scenarios run against Pi and native implementations |
| Q-04 | Static absence proof | Text, AST, LSP, manifest, lockfile, dependency tree, built artifact, and packed release show zero live Pi dependency or product path |
| Q-05 | Fault injection | Provider, process, tool, persistence, compaction, RPC, UI, settings, hook, and plugin failures |
| Q-06 | Security matrix | Zero trust, approval, plan, lock, path, protocol, hook, plugin, and secret bypasses |
| Q-07 | Performance matrix | Startup, first event, turn, append, import/replay, memory, frame, cancellation, and reliability |
| Q-08 | Platform matrix | Supported OS, architecture, runtime, terminal, browser, and native artifact |
| Q-09 | Before/after receipts | Named commits, normalized traces, raw hashes, differences, decisions, and owners |
| Q-10 | Canary, toggle, and rollback | A release-owned `pi|shadow|native` selector during the bounded comparison window, cohorts, per-session host/oracle identity, one writable host, zero-tolerance triggers, tested prior-native rollback, observation, and selector deletion with Pi |

## Current versus target product matrix

| Capability | Current Octocode on Pi | Target native Octocode | Migration rule |
|---|---|---|---|
| Runtime owner | Pi coding-agent | Octocode agent core | Remove native Pi only after conformance |
| Pi extension | Primary harness implementation | Removed | Freeze as the temporary oracle, migrate or approve every difference, then delete after native-only rollback passes |
| Terminal | Pi-host UI/shell | OpenTUI semantic adapter | Preserve behavior; keep toolkit outside core |
| Interactive/print/JSON/RPC | Pi runners/protocol | Native adapters | Same approved modes and protocol semantics |
| Sessions | Pi manager/JSONL | Native versioned store plus Pi importer | Never rewrite the Pi source in place |
| Branch/fork/rewind | Pi host/session APIs | Native projection/controller | Equal ancestry and selected leaf |
| Compaction | Pi callbacks/retry | Explicit state machine | Preserve durable state and one terminal result |
| Tools | One Pi registration funnel | Canonical registry | Preserve names/schemas unless approved |
| Commands | 26 registrations | Canonical registry | Preserve approved inventory/context privilege |
| Policy | Extension gates around Pi calls | Kernel-owned pre-effect chain | Zero bypass across transports/plugins |
| Hooks | Pi events, composer, direct listeners | Canonical bus plus Codex adapter | Every used listener must map |
| Plugins | Static Pi TypeScript extension behavior | Versioned manifests and typed transactional contributions | No direct private-runtime mutation |
| Settings | Protected Pi-extension page plus launcher writer | One registry-driven native page | Temporary Pi projections exist only for comparison; zero hidden native settings |
| Models | Default values and external sources | Full effective catalog and safe `models.json` management | Preserve/import sources with explicit precedence |
| Tests | Pi-specific and candidate structural harness | Shared host corpus plus adapter suites | Same scenario, normalized trace, first divergence |
| Rollback | SDK/subprocess fallback | Prior native release artifact | Final rollback must not depend on Pi; no hidden production fallback after removal |
| Editor/IDE integration | Private host and RPC seams | ACP adapter over canonical ports | Do not invent an editor-specific protocol or expose core internals |
| Context selection | Prompt assembly plus on-demand Octocode tools | Budgeted instruction, semantic-map, and deferred-tool pipeline | AST/LSP evidence is freshness- and provenance-bound |
| Change review | Session rewind and candidate widget seams | Diff/checkpoint timeline with selective restore | Files and conversation can roll back independently or together |

## Extensibility comparison with other systems

This matrix compares documented extensibility surfaces, not model quality, product popularity, or undocumented behavior. “Not established” means the checked primary source does not make a sufficient claim; it does not mean the system lacks the feature.

Legend: **Yes** = documented; **Partial** = narrower or materially different; **Planned** = required by this RFC but not implemented; **Not established** = no decision-grade support in the reviewed source.

| Capability | Pi extensions | Codex hooks | Claude Code | OpenCode | Target Octocode |
|---|---|---|---|---|---|
| Primary customization form | TypeScript extension module | JSON/TOML hook definitions | Settings/plugin JSON plus command, HTTP, MCP, prompt, and agent handlers | JavaScript/TypeScript plugin | Canonical typed plugins plus Codex JSON/TOML compatibility |
| Lifecycle/tool interception | Yes | Yes | Yes | Yes | Planned |
| Block/modify tool calls | Yes | Yes | Yes | Yes | Planned with kernel revalidation |
| Command hook handler | Extension code | Yes | Yes | Plugin code | Planned |
| MCP-tool hook handler | Extension can call APIs; format differs | Yes | Yes | Plugin API; exact hook form differs | Planned, already-connected server only |
| HTTP hook handler | Extension code can implement | Not in declared first compatibility scope | Yes | Plugin code can implement | Deferred unless separately specified |
| Prompt/agent-evaluated hook | Extension code can call a model | Parsed but skipped by documented Codex behavior | Yes | Plugin can generate/model-call | Deferred; parsed and reported unsupported |
| Async hook mode | Async extension handlers | Yes, observation-only constraints | Yes | Promise-based hooks | Planned with nonblocking-only authority |
| JSON/TOML portable hook config | No; TypeScript-first | Yes | JSON settings/plugin hooks | No; TypeScript/JavaScript-first | Planned Codex-compatible |
| Custom tools | Yes | Not established by reviewed hook source | Via MCP/plugin components; not direct hook definition | Yes | Planned typed contribution |
| Custom commands/skills | Yes | Not established by reviewed hook source | Yes | Yes | Planned typed contribution |
| Custom terminal UI | Yes, Pi TUI types | Not established by reviewed hook source | Not established by reviewed sources | Yes, including CLI/TUI plugins | Planned semantic UI contribution, OpenTUI adapter-private |
| Session-persistent extension state | Yes through session entries | Not established by reviewed hook source | Not established by reviewed sources | Plugin session APIs exist; persistence contract differs | Planned version/hash provenance and plugin data boundary |
| Package sources | Local, npm, and Git | Hook-bearing Codex plugin package | Local/plugins/marketplaces and packaged components | Local and npm/versioned packages | Planned compatible manifest; source policy remains implementation decision |
| Source merge | Additive extension discovery/settings | Matching hook sources merge | Hook sources merge | Config/plugin arrays compose in order | Planned deterministic merge |
| Exact-definition hash review | Not established | Yes | Not established by reviewed sources | Not established by reviewed sources | Planned |
| Managed-only hook policy | Not established | Yes | Yes (`allowManagedHooksOnly`) | Not established by reviewed sources | Planned |
| Capability-scoped plugin grants | Extensions run trusted code with broad host access | Hook types are bounded, command remains code execution | Handler and managed-policy controls; broad command/plugin code remains possible | Plugin receives powerful client/shell APIs | Planned deny-by-default grants |
| Transactional contribution activation | Not established | Not established by reviewed hook source | Not established by reviewed sources | Not established by reviewed sources | Planned |
| Deterministic reverse unload/leak proof | Reload supported; formal transaction not established | Async work is session-bounded; general plugin unload not established | File watching/plugin management documented; formal transaction not established | Watched reload and disposable registrations exist | Planned with leases and reverse cleanup |
| Human settings/control center | Terminal/settings files | Codex configuration and hook review flows | `/hooks`, plugin commands, and settings | Config/CLI plugin management | Planned unified HTML for settings, models, hooks, and plugins |
| Host-neutral conformance suite | No Octocode cross-host target | Not applicable | Not applicable | Not applicable | Planned across native and supported Pi hosts |
| Pi-extension compatibility after native removal | Native system | Not applicable | Not applicable | Not applicable | Planned and mandatory |

## Where the target is intentionally better

The target does not try to win by exposing the broadest possible in-process object. It aims to improve five areas:

1. **Portability:** Codex-format declarative hooks run without rewriting, while native typed plugins can add broader contributions.
2. **Least privilege:** plugin code receives explicit capability grants instead of a broad runtime/SDK object by default.
3. **Transactional lifecycle:** activation either publishes every validated contribution or removes all of them; unload has leases and leak proofs.
4. **Explainability:** one HTML page shows sources, effective values, exact review hashes, permissions, contributions, compatibility, health, and redacted traces.
5. **Migration proof:** the same semantic corpus runs on Pi and native hosts, so “better” must survive before/after, security, fault, and performance gates.

These are planned advantages. The RFC must not market them as delivered until the implementation and release evidence reaches Level 5.

## Competitive gaps and decisions

| Gap against documented systems | Decision |
|---|---|
| Claude Code supports HTTP, prompt, and agent hook handlers beyond the first Codex-compatible scope | Keep first scope to command and MCP handlers; parse/report unsupported types. Add only through a separate security and determinism review. |
| Pi provides deep in-process TUI customization | Offer semantic UI contributions with headless fallbacks; do not leak OpenTUI or runtime internals into plugins. |
| Pi and OpenCode load arbitrary TypeScript/JavaScript plugins directly | Preserve a code-plugin path, but require manifest identity, trust, capabilities, containment, and auditable activation. |
| Claude Code and OpenCode have broader published plugin component/package ecosystems | Prioritize compatibility import, stable schemas, CLI/HTML management, and package-source policy before marketplace scale. |
| Existing systems already ship their extension runtime | Treat target advantages as hypotheses until shared conformance, adversarial security, unload, and canary receipts prove them. |
| Gemini CLI and OpenCode implement ACP; Codex exposes a rich app-server | Implement version-pinned ACP over canonical ports; retain native RPC for Octocode automation rather than creating another editor protocol. |
| Aider budgets a semantic repository map and Codex supports deferred tool search | Build context governance around Octocode AST/LSP and searchable deferred schemas; never inject an unbounded repository/tool catalog. |
| Gemini CLI and Cline expose checkpoint restore and diff review | Add an accessible selective-restore timeline backed by the native session/checkpoint owner. |
| MCP durable tasks are evolving from an experimental core feature into an extension | Pin the chosen extension revision and isolate it behind capability negotiation; do not claim support from generic MCP connectivity. |
| A2A supports remote agent cards, tasks, streaming, and push notifications | Defer to an optional post-cutover adapter; Awareness remains the internal coordination authority. |

## Minimum viable implementation slice

The first reviewable vertical slice is deliberately smaller than the full product:

1. Create agent core with canonical event/tool/command contracts and validators.
2. Adapt the current Pi extension to those contracts without behavioral change.
3. Run one deterministic session-start, prompt, tool-denial, tool-success, and shutdown scenario on Pi.
4. Load one trusted Codex `PreToolUse` command hook and prove exact input/deny behavior.
5. Load one synthetic plugin that contributes one namespaced command and unload it transactionally.
6. Show both definitions and their redacted receipts in read-only Hooks/Plugins settings projections.
7. Pass cancellation, timeout, changed-hash trust, duplicate registration, partial activation, and cleanup tests.

This slice raises event/hooks/plugins and registries to Level 3. It does not justify a native runtime canary because sessions, model loop, transports, and terminal remain Pi-backed.

## Measurement and refresh rules

- Recalculate readiness only from linked receipts on a named commit.
- Record a maturity increase beside the implementation issue and evidence path.
- Do not average away a zero-tolerance failure. Security bypass, data loss, duplicate effect, protocol corruption, compaction loop, untrusted execution, partial activation, or resource leak forces hold/rollback.
- Refresh external comparison claims when their pinned source changes or before implementation chooses a compatibility behavior based on them.
- Keep “documented,” “observed,” “planned,” and “proven” labels distinct.

## Sources checked on 2026-08-28

- [Official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) — lifecycle events, JSON/TOML sources, merge, matchers, command/MCP handlers, trust, managed policy, async behavior, and plugin hook packaging.
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) — TypeScript extensions, events, tools, commands, UI, state, discovery, and package behavior.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) and [plugin reference](https://code.claude.com/docs/en/plugins-reference) — handler types, events, managed policy, merging, components, and packaging.
- [OpenCode plugin loading](https://opencode.ai/v2/docs/plugins) and [plugin API](https://opencode.ai/v2/docs/build/plugins) — local/npm loading, ordering, hooks, tools, permissions, session APIs, and UI/plugin surfaces.
- [Coding-agent landscape receipt](evidence/coding-agent-landscape-2026-08-28.md) — Codex, Gemini CLI, Qwen Code, OpenCode, goose, Aider, Cline, MCP, ACP, A2A, AGENTS.md, Octocode adoption, and AST/LSP reachability.

External documentation is evidence for comparison only. `TEST_PLAN.md` and commit-addressed local receipts remain the oracle for Octocode implementation readiness.
