# Implementation: Remove `pi-coding-agent`

> Decision: `RFC.md` §Summary and §Rationale and alternatives. Current progress: `STATUS.md`. Operational order: `STEPS.md`. Readiness rating and feature IDs: `READINESS_AND_FEATURE_MATRIX.md`. Prerequisites: `PREREQUISITES.md`. Stage roadmap: `MIGRATION_STAGES.md`. Contract owner: `SCHEMAS_AND_TYPES.md`. Hooks/plugins: `HOOKS_AND_PLUGINS.md`. Native terminal: `OPENTUI_TERMINAL_CORE.md`. Unified settings page: `SETTINGS_WEB_UI.md`. Mandatory tests: `TEST_PLAN.md`. Pass/fail rules: `KPI.md`.

## Resolved questions and deferrals

| RFC question | Resolution or explicit deferral | Evidence | Confidence |
|---|---|---|---|
| Q1: Package ownership | `packages/octocode-agent-core/` is the single production owner of host-neutral contracts, kernel, sessions, prompt assembly, lifecycle/registries, and runtime adapters. The launcher composes it; the Pi extension is an independent inbound compatibility adapter. | User decisions on 2026-08-26 and 2026-08-29; current package boundary and focused tests | Implemented candidate |
| Q2: Native session encoding | Defer to Phase 3. Compare append-only JSONL, SQLite, and SQLite plus export log; select only after corruption/replay/migration prototypes. | Current Pi JSONL consumer in `packages/octocode-agent/src/sessions.ts`; Awareness proves local SQLite operation | Deferred with trigger |
| Q3: Public event fields | Resolve in Phase 0 from refreshed Pi RPC fixtures, shell events, composed hooks, and flow-harness traces. | `pi-custom-tui-protocol/RESOLUTION.md`; current event interfaces in `src/types.ts` | High-confidence route |
| Q4: Compatibility window | Release owner sets this before Phase 6. Until then, the migration selector and Pi-backed rollback route cannot be removed. | RFC rollback requirement | Explicitly deferred |
| Q5: Retain `pi-agent-core` | Retain by default for the first `pi-coding-agent`-free composition. Reassess at Phase 4 entry only if the contract suite exposes a blocker. | Scope isolation in `RFC.md` §Guide-level explanation | Confirmed decision |
| Q6: Native terminal | Use `@opentui/core` directly behind `UiPort`; keep the custom TUI protocol as a compatibility/transport fixture unless separately shipped. Stage 1 must prove an upstream-supported Bun or Node runtime/package route. | User decision on 2026-08-27; `OPENTUI_TERMINAL_CORE.md` and official upstream runtime/testing docs | Confirmed decision with compatibility gate |
| Q7: Settings surface | Use the existing loopback `settings.html` as the single human-facing control center. Add schema-driven agent-core settings/model contracts and a complete Models/`models.json` section; keep HTML/browser code outside core. | User decision on 2026-08-27; current `mcp-html.ts`, `SETTINGS.md`, launcher `settings.ts`, AST/LSP inventory | Confirmed decision |
| Q8: Pi product end state | Retain `@octocodeai/pi-extension` as an independently installed Pi compatibility product. Prohibit Pi from native source, manifests, dependencies, artifacts, installers, updates, selectors, fallbacks, and rollback paths. | User decision on 2026-08-29; reassessment audit in `RFC.md` | Confirmed decision |

No phase may start when its trigger-row remains unresolved. Checkboxes below describe release-evidenced completion; current dirty-tree code may be implemented or composed out of sequence and is rated in `READINESS_AND_FEATURE_MATRIX.md` and root `08-TRACEABILITY-CHECKLIST.md`.

The latest integrated candidate receipt is [the 2026-08-28 real runtime surface evaluation](evidence/real-runtime-surface-eval-2026-08-28.md). It verifies bounded worker recovery/projection, provider adapters, command hooks, plugin activation, browser settings, and one host-specific PTY run. It does not check a phase or relax any clean-baseline, real-host, platform, canary, rollback, or removal gate.

## Approach

Introduce host-neutral contracts around existing behavior, pin the Pi-backed implementation as an independent conformance reference, and replace one capability at a time in the native editor. Preserve one public native runtime composition root and one shared conformance suite. Remove every Pi path from native releases while retaining the isolated Pi extension and its adapter-local compatibility code.

## Phase 0: Freeze evidence and behavior

- [ ] Select the baseline commit and record dirty-state policy in `evidence/before-<commit>.md`.
- [ ] Run every baseline command in `PREREQUISITES.md` and record exit code, totals, duration, and environment.
- [ ] Export machine-readable inventories for SDK exports, production Pi imports, host methods, events, tools, commands, UI operations, session operations, modes, and settings.
- [ ] Capture ordered golden traces for startup, input, one model turn, streamed tool execution, cancellation, failure, shutdown, new/resume/fork/tree, and all compaction reasons.
- [ ] Refresh the prior RPC fixtures against the selected baseline.
- [ ] Classify each event field as public, internal, redacted, or removed.
- [ ] Review the in-progress `@octocodeai/agent-testing` package as the conformance owner; make its failure modes deterministic before using it as an oracle.
- [ ] Add negative fixtures for policy denial, untrusted workspace, peer lock, invalid RPC, stale session revision, and aborted child work.
- [ ] Run the OpenTUI runtime/packaging spike in `OPENTUI_TERMINAL_CORE.md` and record the selected Bun or Node route, exact version, platform matrix, native artifact behavior, startup, memory, and restoration.
- [ ] Freeze the existing OpenTUI proof adapter/view-model and four focused tests as observed fixtures; record its AST calls and LSP references before moving or renaming the boundary.
- [ ] Specify the migration-only `pi|shadow|native` selector at the release composition boundary, including precedence, per-session host/oracle identity, one-writer enforcement, observability, and deletion criteria. The current native launcher is hard-wired to `native`; do not add this selector to agent core.

**Proceed gate:** all baseline checks are reproducible and every used Pi capability maps to a fixture or an explicitly approved non-fixture invariant.

## Phase 1: Introduce host-neutral contracts

- [ ] Create `packages/octocode-agent-core/` through the repository's approved package/manifest process.
- [ ] Keep agent core independent of `packages/octocode-agent`, `packages/octocode-pi-extension`, and terminal UI packages; verify dependency direction mechanically.
- [ ] Place all new production runtime contracts and kernel implementations in agent core with no `pi-coding-agent` import.
- [ ] Define `AgentRuntime`, `RuntimeEvent`, `ExecutionContext`, `ToolRegistry`, `CommandRegistry`, `LifecycleBus`, `SessionIdentityReader`, `SessionController`, `SessionStore`, `ModelPort`, `UiPort`, `ProcessPort`, `TrustPolicy`, and `TranscriptPort`.
- [ ] Define `SettingsRegistry`, `SettingsService`, settings/model source contracts, provenance, precedence, revisions, redacted projections, and change events from `SETTINGS_WEB_UI.md`.
- [ ] Implement the schema/type source-of-truth and version rules in `SCHEMAS_AND_TYPES.md`.
- [ ] Separate tool schema/execution from policy metadata and rendering metadata.
- [ ] Encode command-only operations so tool/event contexts cannot call session replacement APIs.
- [ ] Define middleware order, transformation, blocking, timeout, and error semantics.
- [ ] Define a versioned RPC/JSON schema from the same event contracts.
- [ ] Implement a Pi compatibility adapter that satisfies the contracts without changing product behavior.
- [ ] Preserve `@octocodeai/pi-extension` as an independent compatibility adapter that imports public agent-core contracts and owns every Pi-specific translation.
- [ ] Move the deterministic test harness from Pi-named public types to host-neutral contract fixtures while retaining a Pi adapter suite.

**Proceed gate:** the existing Pi-backed product runs through the new contracts, all baseline fixtures match, the Pi extension passes its declared Pi-version matrix, and no product module outside the adapter needs a Pi host type.

**Rollback:** remove the contract composition layer; no persistence format changes occur in this phase.

## Phase 2: Extract registries, lifecycle, policy, and helpers

- [ ] Replace `PiInstance` usage with capability injection.
- [ ] Move event dispatch, hook decisions, and contribution registration into agent-core contracts; keep `OctocodeHookComposer` adapter-local to the independent Pi extension.
- [ ] Map every production `hooks.on(...)` and direct `pi.on(...)` listener to a canonical event with ordering, mutability, timeout, and failure semantics.
- [ ] Implement Codex hook schema/discovery/trust plus bounded command and MCP handlers behind feature enablement.
- [ ] Implement versioned plugin manifests, capability grants, transactional activation/unload, and typed contributions.
- [ ] Move the single tool funnel to `ToolRegistry`; preserve names, prepared arguments, schema compaction, policy, updates, results, and rendering metadata.
- [ ] Move all 26 command registrations to `CommandRegistry`; preserve discovery and argument completion.
- [ ] Replace the hook composer with a typed ordered `LifecycleBus`.
- [ ] Centralize trust, approval, plan-mode, and peer-lock evaluation before execution.
- [ ] Replace shell-config, frontmatter, settings, HTML-export, and RPC-type dependencies with Octocode-owned implementations.
- [ ] Remove direct official Pi types from production tool/context contracts.

**Proceed gate:** registry and lifecycle dual-host suites pass; standalone helper imports are gone; policy negative tests are identical.

**Rollback:** after the migration selector is implemented and verified, select the frozen Pi adapter; retained session data remains untouched. Before that proof exists, this phase has no deployable host-switch rollback and cannot enter canary.

## Phase 3: Implement native sessions, prompt assembly, and compaction

- [ ] Resolve Q2 with a written comparison and prototype receipts.
- [ ] Implement versioned append/load, expected revisions, atomicity, recovery, and deterministic projection.
- [ ] Implement session identity, naming, entries, branch, tree, fork, resume, switch, labels if proven needed, and export.
- [ ] Implement a read-only Pi JSONL importer and native conversion that writes to a new destination.
- [ ] Preserve custom entries outside model context and preserve Awareness/session artifact identity.
- [ ] Move prompt assembly to pure inputs and snapshot its byte and semantic forms.
- [ ] Implement manual, threshold, overflow, retry, and cancellation compaction states.
- [ ] Run corruption, interrupted-write, duplicate-event, stale-revision, and migration fault tests.

**Proceed gate:** representative Pi sessions import and replay without loss, prompt changes are approved, and compaction fault tests terminate in one valid state.

**Rollback:** reopen the original Pi session read-only through the Pi host. Never reverse-convert native data in place.

## Phase 4: Compose the native runtime

- [ ] Compose the runtime kernel using the retained `pi-agent-core` and `pi-ai` adapters unless Q5 is reopened with evidence.
- [ ] Implement structured execution scopes and cancellation ownership for model turns, tools, child processes, and background work.
- [ ] Normalize model deltas into `RuntimeEvent` without exposing provider-specific payloads to product modules.
- [ ] Make Responses the canonical OpenAI transport, including reasoning items, hosted and MCP tools, approvals, tool search, persisted response state, background status, usage, and typed errors.
- [ ] Implement or explicitly retire every provider protocol in the approved model matrix.
- [ ] Port the complete file/edit, shell, web/search, browser/CDP, media/PDF/ffmpeg, local-server, call-tool, memory, and coordination palette with truthful composite effects.
- [ ] Replace per-operation MCP connections with a persistent catalog and complete auth, sampling, elicitation, roots, progress, subscription, and approval flows.
- [ ] Complete native Skills discovery, provenance, budgets, refresh, usage, context registration, and explicitly authorized lifecycle operations.
- [ ] Implement retry classification, usage accounting, model selection, and thinking-level control.
- [ ] Run Pi and native implementations through the same mocked-provider scenarios.
- [ ] Add shadow comparison only for pure snapshots and normalized events; prohibit duplicate external effects.

**Proceed gate:** native runtime passes every deterministic scenario and stress/fault suite; no duplicated-effect receipt exists.

**Rollback:** during the bounded comparison window, use the verified release selector to choose `pi`; native sessions remain isolated and readable for diagnosis. The current native launcher does not yet provide this selector, so this rollback is a release gate rather than a present capability.

## Phase 4A: Compose sessions, workers, messaging, and flow control

- [ ] Compose every session command and compaction transition into interactive, print, JSON, RPC, and embed paths.
- [ ] Add an agent-core coordination port and native Awareness adapter. Reuse Awareness plans, tasks, agents, work presence, locks, checks, messages, handoffs, outbox, and verified memory rather than creating a second authority.
- [ ] Add durable addressed session/worker mailboxes with correlation, unread/read/ack, broadcast, handoff acceptance, provenance, redaction, expiry, and restart delivery.
- [ ] Implement a native structured worker supervisor with typed spawn packets, capability limits, durable ledgers/handbacks, active caps, crash cleanup, and joined shutdown.
- [ ] Port list/status/send/steer/follow-up/wait/abort/kill semantics with queue depth, liveness probes, graceful unwind, escalation, and reliable waiter resolution.
- [ ] Replace single-active plan execution with bounded dependency-ready scheduling, atomic Awareness claims/leases, path ownership, and safe native worktree lifecycle.

**Proceed gate:** all `A-*` and `S-*` scenarios pass against production native composition; two-process messaging survives restart; no duplicate Awareness authority, orphan process, lost queue item, invalid session graph, or discarded unmerged work exists.

## Phase 5: Deliver transport and UI parity

Progress: the native launcher shares a core settings service between runtime model
selection and `/settings`; the protected page edits theme and default model. A
trust-gated extension controller also owns review, activation transactions,
contributions, and leases. The unchecked items below remain the phase-completion
contract.

- [ ] Implement native interactive, print, JSON, and RPC adapters over `AgentRuntime`.
- [ ] Add Hooks and Plugins to `settings.html`, including source provenance, exact-hash review, enablement, compatibility, health, permissions, contributions, semantic diff, and redacted traces.
- [ ] Run native and independent Pi-extension hook/plugin conformance across interactive, print, JSON, RPC, and headless adapters.
- [ ] Generalize the existing `settings.html` implementation into the registry-driven all-settings control center specified by `SETTINGS_WEB_UI.md`.
- [ ] Add `/settings models`, the effective model catalog/default selection, structured provider/model editing, and validated revision-safe `models.json` management.
- [ ] Route launcher config commands through the same `SettingsService`; keep Pi projections adapter-local and remove duplicate native direct writers after AST/LSP callers migrate.
- [ ] Preserve shell submit/subscribe/abort/streaming behavior.
- [ ] Preserve semantic notifications, dialogs, status, widgets, title, editor, autocomplete, footer/header, working indicator, and headless degradation.
- [ ] Implement `packages/octocode-agent/src/terminal/opentui/` with `@opentui/core` directly, following `OPENTUI_TERMINAL_CORE.md`.
- [ ] Use `@opentui/core/testing` for deterministic frames, input, mouse, resize, focus, clock, capability, and renderer-destruction tests.
- [ ] Remove native `pi-tui` use after OpenTUI parity passes; keep Pi UI mapping adapter-local in the independent extension.
- [ ] Version RPC and provide a compatibility adapter for the accepted fixture corpus.
- [ ] Verify exit codes, stdout/stderr separation, signals, terminal restoration, and malformed-client behavior.

**Proceed gate:** the mode matrix in `KPI.md` passes on supported platforms, the accepted OpenTUI runtime/package route passes its matrix, native `pi-tui` references are zero, every supported setting appears in `settings.html`, Models/`models.json` mutations pass security/data-integrity gates, Codex hook fixtures and plugin lifecycle/security suites pass on native and the independent Pi extension, and no critical accessibility or terminal-restoration regression remains.

## Phase 6: Make the native editor the sole default

- [ ] Resolve Q4 and publish the observation-window rule.
- [ ] Make the native editor the default while retaining explicit Pi comparison rollback only during the observation window.
- [ ] Observe success, error, abort, compaction, session import, and policy guardrails for the approved window.
- [ ] Capture `evidence/after-<commit>.md` and the exact before/after comparison.
- [ ] Remove native SDK loading, Pi package resolution, SDK/subprocess fallback, and Pi RPC type imports.
- [ ] Replace unsupported/deep Pi-extension imports with native contracts and adapters; do not create a new permanent Pi facade.
- [ ] Remove Pi dependencies from native agent/core manifests using the repository's approved manifest-change process.
- [ ] Run AST/LSP absence proofs and dependency-tree checks.
- [ ] Rebuild awareness, extension/runtime, testing, and agent packages; run real CLI, print, and RPC paths.

**Proceed gate:** every target and guardrail in `KPI.md` passes; native agent/core references are zero; the observation window passes; prior-native-artifact rollback succeeds; release owner signs the evidence comparison.

**Rollback:** while the adapter remains installed, restore `pi` selection. If the package has been removed from a release artifact, roll back the artifact rather than hot-patching user session data.

## Phase 7: Close native Pi paths and retain the compatibility extension

- [ ] Remove the Pi host selector from native `octocode-agent` after the approved window.
- [ ] Migrate or explicitly retire every Pi-only native setting, command, tool, asset, fixture, installer, updater, and document.
- [ ] Keep `packages/octocode-pi-extension`, its Pi-only dependencies, supported-version matrix, tests, documentation, and publication path isolated from native release wiring.
- [ ] Preserve redacted compatibility fixtures and historical receipts as regression evidence.
- [ ] Document package ownership as “native runtime” and “independent Pi compatibility extension.”
- [ ] Audit related RFCs and re-point Pi-facing references without deleting their unique semantic requirements.
- [ ] Prove zero Pi text, AST/LSP reachability, manifest, lockfile resolution, dependency-tree, built-JS, packed-artifact, installer, updater, and release references for native packages; classify extension-owned Pi references separately.
- [ ] Run clean install, previous-release upgrade, every native mode, and CLI/MCP/skill/browser/media/editor/session smokes before signing the irreversible deletion receipt.

## Files, APIs, and contracts

| Surface | Change | Blast-radius evidence | Compatibility |
|---|---|---|---|
| `packages/octocode-agent-core/` | Owner for contracts, kernel, sessions, prompt assembly, lifecycle/registries, and runtime adapters | Package exists as a partially implemented dirty-tree candidate | Independent Pi extension supplies comparison behavior without entering native release wiring |
| Historical `packages/octocode-agent/src/sdk-launcher.ts` | Replaced by native runtime composition | Removed; nine SDK exports defined the baseline extraction surface | Immutable baseline evidence only |
| `packages/octocode-agent/src/native-launcher.ts` | Compose the Octocode runtime directly | Current production candidate | Release-artifact rollback |
| `packages/octocode-agent/src/native-transports.ts` | Use local versioned print/JSON/RPC contracts | Current production candidate; concurrent control remains open | Wire compatibility tests |
| `packages/octocode-agent/src/sessions.ts` | Read native store; retain Pi importer | Reads Pi session buckets | Read-only import window |
| `packages/octocode-agent/src/settings.ts` | Replace direct CLI file writes with the canonical `SettingsService` | Three public allowlisted keys; `config list` is redacted, but `setSetting` remains a direct writer | Compatibility adapter until caller migration and source import proof |
| `packages/octocode-pi-extension/src/tools/mcp-html.ts` | Generalize into unified settings HTML adapter and section contributors | Eight sections, 11 actions; `openMcpManager` has four LSP references | Deep-link/output-path compatibility window |
| `packages/octocode-agent/src/native-settings-service.ts` and `native-settings-page.ts` | Native core-service persistence bridge and protected settings page | Production-composed bounded slice | Expand through the same settings conformance suite as the Pi extension |
| `packages/octocode-agent/src/terminal/opentui/` | Native interactive terminal adapter using `@opentui/core` | Production-composed semantic widgets/input; PTY/platform evidence required | Pi-backed comparison during the bounded window; native release-artifact rollback afterward |
| `packages/octocode-pi-extension/src/types.ts` | Replace duplicated domain contracts with agent-core imports plus Pi-only adapter types | LSP: 64/172/54 key references | Independent extension mapping |
| `packages/octocode-pi-extension/src/index.ts` | Compose host-neutral registries/lifecycle | 17 middleware in the inspected 2026-08-27 tree, 18 core commands | Golden ordering/inventory |
| `packages/octocode-pi-extension/src/tools/octocode-tools.ts` | Point one registration funnel at `ToolRegistry` | One host registration call | Tool contract suite |
| Shell and UI modules | Consume semantic runtime/UI contracts and migrate native rendering to OpenTUI | Structural runtime and nine `pi-tui` importing files | OpenTUI parity suite; Pi extension retains host UI mapping |
| Session/compaction modules | Use `SessionStore` and `SessionController` | Broad identity, branch, artifact, retry use | Migration/replay/fault suite |
| `packages/octocode-agent-testing` | Become shared conformance fixture package | Existing ordered fail-closed flow harness | Run against Pi and native adapters |
| Hook/plugin compatibility sources | Add Codex fixtures, exact-hash trust records, event adapters, and manifest/contribution validation | Current composed and direct Pi listeners | Same canonical decisions on native and independent Pi-extension hosts |

## Risk mitigations

| RFC risk | Preventive action | Detection |
|---|---|---|
| Event drift | One ordered bus and normalized fixture schema | Sequence diff with first divergence |
| Prompt drift | Pure assembler and reviewed snapshots | Hash plus semantic diff |
| Data loss | Read-only import, new destination, revisions, backups | Replay/checksum/property tests |
| Duplicate effects | Effect classification; no shadow writes/model calls | Effect receipt uniqueness |
| Security bypass | One pre-execution policy chain | Negative matrix across all transports |
| Cancellation leaks | Structured scopes and owned children | Open-handle/process leak checks |
| UI-only failure | Headless semantic assertions | Missing critical-event guardrail |
| OpenTUI packaging/runtime failure | Stage 0 compatibility spike and supported-platform artifact matrix | Install/start/render/restore receipts |
| Settings/model loss or secret exposure | Schema registry, redacted types, revisions, semantic diff, atomic writes, backups, CSP/origin/token/trust/path checks | Fault/security suite plus generated-artifact secret scan |
| Permanent adapter | Phase deletion lists and release owner | Dependency/reference KPI trend |
| Hook/plugin policy bypass or partial activation | Kernel-owned authorization, capability grants, exact-definition trust, transactional registry | Negative matrix, audit traces, duplicate/leak counters |

## Test and verification plan

`TEST_PLAN.md` owns the complete mandatory suite, mode matrix, fault injection, security, performance, evidence receipt, and release sign-off. The following table maps implementation work to that test owner.

| Type | Scope | Approach | Command or mechanism |
|---|---|---|---|
| Unit | Registries, reducers, policies, schemas | Table/property tests | Workspace package tests |
| Contract | Pi and native host adapters | Run identical `@octocodeai/agent-testing` scenarios | Testing workspace suite |
| Golden | Events, prompts, RPC, command/tool inventory | Normalized fixture diff | Fixture runner created in Phase 0 |
| Fault | Session writes, compaction, cancellation, process exit | Inject failures at every state transition | Runtime/session fault suite |
| Security | Trust, approval, lock, plan-mode gates | Negative cases across modes | Harness plus real-path smoke |
| Integration | Launcher, shell, session, export, modes | Built packages and mocked provider | Agent/extension integration suites |
| End-to-end | Real CLI/MCP/skill path | Build then run documented local path | `AGENTS.md` §Build and local run |
| Static | Imports, calls, references, dependency graph | Octocode AST/LSP plus package manager graph | Queries in `KPI.md` |

Verification proves the implementation matches the design. Validation proves that outcomes visible to operators and guardrails in `KPI.md` moved.

## Rollout, migration, and rollback

1. Ship contracts and Pi adapter with no behavior change.
2. Enable native only in tests, then explicit developer opt-in.
3. Enable pure shadow comparison; never shadow effects.
4. Canary native by explicit cohort and preserve per-session host identity.
5. Expand only when the preceding observation window passes.
6. Make native default while Pi remains selectable.
7. Remove `pi-coding-agent` only after the final evidence comparison and owner approval.

Any security bypass, unrecoverable session mismatch, duplicate effect, compaction loop, or protocol corruption triggers immediate rollback. Ordinary metric misses stop expansion and open a corrective phase; they do not rewrite session data.

## Critical references

- `RFC.md` — owns the decision, scope, architecture, and risks.
- `HOOKS_AND_PLUGINS.md` — owns Codex hook compatibility and event-driven extension/plugin behavior.
- `READINESS_AND_FEATURE_MATRIX.md` — owns maturity ratings, target feature IDs, current/target comparison, and external extensibility matrix.
- `STATUS.md` — owns current stage, step, feature, blocker, owner, and evidence state.
- `STEPS.md` — provides the document-linked operational sequence.
- `PREREQUISITES.md` — owns baseline truth and phase-entry blockers.
- `KPI.md` — owns pass/fail metrics, before/after comparison, and rollback thresholds.
- `OPENTUI_TERMINAL_CORE.md` — owns native terminal boundaries, runtime/package gate, lifecycle, and testing.
- `SETTINGS_WEB_UI.md` — owns settings registry/page behavior, Models/`models.json`, mutations, security, migration, and tests.
- `packages/octocode-agent-testing/src/index.ts` — candidate shared deterministic host harness.
- Immutable historical receipts — capture the prior custom-TUI RPC behavior and import-free type boundary; the original `.octocode/rfc/...` path is no longer present.
