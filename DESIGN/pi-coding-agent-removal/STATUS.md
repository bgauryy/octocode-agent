# Migration status: Remove `pi-coding-agent`

Last updated: 2026-08-28
Overall state: **Dirty-tree implementation candidate under verification**
Active stage: **Stages 0–5 and native dependency-removal work overlap; the final Pi-retirement target is approved, but no release stage gate is closed**
Release decision: **HOLD — do not canary, publish, or declare migration complete**

> This file is the canonical progress ledger. `RFC.md` owns scope and decisions. `STEPS.md` owns execution order. `MIGRATION_STAGES.md` owns gates and rollback. `READINESS_AND_FEATURE_MATRIX.md` owns maturity definitions and feature IDs. `KPI.md` and `TEST_PLAN.md` own pass/fail rules. A status update cannot weaken those documents.

## Executive status

| Signal | Current state | Evidence | Next transition |
|---|---|---|---|
| Product end state | Native editor only; Pi is a temporary oracle | User decision on 2026-08-28 and reconciled active design set | Freeze the oracle baseline and bind real Pi/native conformance adapters |
| Exhaustive feature audit | 108/108 IDs classified; 0 cutover-ready and 0 proven cross-host matches. The later production-adapter runner reports 0 matched, 1 divergent, and 13 unsupported scenarios. | `evidence/prompt-audit-2026-08-28.md`; `evidence/coding-agent-landscape-2026-08-28.md`; production-host conformance tests | Implement unsupported production scenarios, resolve the lifecycle divergence, then rerun the real-host ledger |
| Dirty-tree local verification | Build, lint, typecheck, and root tests pass; 3,484 tests passed and 16 native cases skipped | `evidence/integrated-runtime-closure-2026-08-28.md` | Reproduce on a clean named candidate and complete real-host/platform/release matrices |
| Headless runtime evaluation | Text, JSON, piped input, RPC snapshot, and a two-iteration Skill loop pass through the built CLI; requests contain the governed prompt and deterministic tool inventory | `evidence/headless-runtime-eval-2026-08-28.md` | Complete malformed-stream, live cancellation/control, MCP persistence, provider, soak, and clean-platform matrices |
| RFC document set | Reconciled candidate | 17 RFC documents plus 11 root design documents; duplicate root hook/plugin and leftovers pages were merged into their canonical owners | Pass the full link/style/contradiction review and record its receipt |
| RFC/design completeness | 9/10 | `READINESS_AND_FEATURE_MATRIX.md` | Close ownership and baseline blockers |
| Native-editor implementation readiness | 8.5/10 | Production session routing with parent/child navigation, automatic compaction, composite effect admission with persistent receipts, MCP/Skill lifecycle, real owned-orphan recovery, dynamic approval/session-bound RPC/ACP projection, Anthropic Messages, command/MCP/asynchronous hooks, reviewed/granted plugins, browser-tested settings controls, and real PTY restoration pass in the dirty tree | Complete session import/corruption proof, authoritative upstream effects and peer-lock targets, credentialed and broader providers, remaining settings writers, and clean cross-editor/platform evidence; see `evidence/integrated-runtime-closure-2026-08-28.md` |
| Native canary readiness | 2/10 | Real native paths exist, but the current launcher is hard-wired to native and real cross-host/release matrices are incomplete | Implement the release-owned selector and reach every Stage 5 exit gate on a committed candidate |
| Pi-retirement readiness | 2/10 | Direct native Pi guards pass and the end state is approved; Pi remains live/transitive with no oracle freeze, selector, observation, prior-native rollback, install/upgrade, or final absence receipt | Complete `TEMP-*`, `CONF-*`, and `REL-*`; then delete Pi in the gated retirement change |
| Dependency-removal readiness | Focused native static guard passes; complete retirement gate remains open | Native source/direct manifest/built-JS scan passes, but Pi remains transitively reachable and packed-artifact, workflow migration, native-only rollback, and package-deletion proof are absent | Complete all native capability packages, Stage 6 observation, prior-native rollback, and final repository/artifact zero-reference proof |
| Zero-tolerance guardrails | No canary executed | Focused negative/unit tests exist; complete effect/leak/security receipts are absent | Remain at zero and obtain independent verification |
| Execution authority | Full implementation authorized | User explicitly instructed the orchestrator to execute the entire RFC with subagents | Authority does not waive technical or release gates |

## Status vocabulary

Use exactly one state per tracked item:

| State | Meaning |
|---|---|
| Not started | No authorized implementation work or accepted evidence exists |
| In progress | An owner is actively producing the required output |
| Blocked | A named unresolved condition prevents safe progress |
| In review | Output exists and awaits the required approval/gate |
| Complete | Every owning-document requirement passes with linked commit-addressed evidence |
| Rolled back | Work was reverted through the documented rollback path; receipt explains why |

“Complete” requires an evidence link. Percent-complete estimates without feature-ID or gate evidence are prohibited.

## Stage tracker

| Stage | State | Entry gate | Required output | Evidence | Owner | Blocker/next action |
|---:|---|---|---|---|---|---|
| 0. Canonical baseline | In progress | Baseline commit, environments, privacy rules approved | Before receipt, fixture hashes, current behavior inventory | `evidence/before-b7a3b425f555e4a85f0034d6f91a21f5107fe1ac.md`; still HOLD/non-canonical | Octocode maintainers | Complete missing fixtures, hashes, matrices, and independent sign-off |
| 1. Contracts | In review | Stage 0 complete | Agent-core package, contracts, Pi adapter, dependency proof | Dirty-tree package passes 98 agent-core tests plus typecheck, lint, and build; the prior 1,760-test Pi suite receipt remains. Canonical baseline and dependency proof remain open. | Octocode maintainers | Run the clean conformance matrix and close the entry gate |
| 2. Kernel surfaces | In progress | Stage 1 contract suite passes | Registries, lifecycle, hooks/plugins, policy, helpers | Core and native compose canonical composite effects, ordered policy receipts, native receipt persistence, altered-receipt denial, cancellation, plan/interactions, extension discovery, command/MCP hooks, and bounded asynchronous hook ownership | Octocode maintainers | Pin the external facade and compatibility fixtures, add authoritative upstream effects/lock targets, complete receipt crash/expiry semantics, and run the clean security/conformance matrix |
| 3. Sessions | In progress | Stage 2 complete; store decision approved | Native store, Pi importer, projection, compaction | The durable launcher composes replacement fixed-session runtimes for create/resume/switch/fork/name/export and previous/next/parent/child navigation; manual and threshold compaction, cancellation, bounded failure handling, and restart recovery pass focused tests | Octocode maintainers | Complete import, overflow compaction, and the migration/corruption/crash corpus |
| 4. Runtime | In review | Stage 3 corpus passes | Native model/tool loop and pure shadow proof | Native kernel/model/transports, durable frozen prompt composition, input/context/tool lifecycle authority, official Responses streaming, ACP v1 stdio and permission bridging, bounded inputs/effects, durable plan composition, MCP elicitation/tasks/provenance/persistence, hierarchical discovery, and Skill lifecycle pass focused tests | Octocode maintainers | Complete shadow/effect, fault, credentialed-provider/editor, and performance proof |
| 5. Transports/UI/settings | In progress | Stage 4 plus OpenTUI route passes | Native modes, OpenTUI, settings/models/hooks/plugins | Native transports, session-bound RPC/ACP worker projection, typed OpenTUI state, dedicated widgets, transactional plugin/hash review and capability grant/revoke settings actions, browser accessibility/save flow, and one real-PTY exact-restoration run pass; Node 26 required experimental FFI | Octocode maintainers | Finish configuration panels and run clean cross-browser, terminal, and platform matrices |
| 6. Native default | Not started | Stage 5 complete; thresholds and rollback approved | Canary/default receipts and observation metrics | Pending | Octocode maintainers | Stage 5 and release policy |
| 7. Complete Pi retirement | In review | Observation window and native-only rollback pass | Zero Pi dependency/product path and deleted extension package | Focused native source/direct-manifest/built-JS guard passes; transitive Pi path, missing native capabilities, package deletion, and release evidence remain | Octocode maintainers | Complete every `R/T/S/H/P/U/A/Q` gate, migrate workflows, then delete Pi and run packed/install/upgrade proof |

Stage details, entry/exit criteria, and rollback remain in `MIGRATION_STAGES.md`.

## Step tracker

| Step | State | Deliverable | Evidence | Owner | Next action |
|---:|---|---|---|---|---|
| 0. Approve scope and owners | Complete | Accepted scope/owner receipt plus clarified end-state decision | Historical `evidence/stage-0-approval-record.md` plus explicit user instruction on 2026-08-28 that the new editor must replace Pi completely | Octocode maintainers | Preserve historical evidence; apply the superseding native-only target in active docs |
| 1. Freeze before baseline | In progress | Canonical before receipt and fixture corpus | Detached before receipt exists but remains HOLD/non-canonical | Octocode maintainers | Complete fixture/hash/matrix values and independent sign-off |
| 2. Prove OpenTUI route | In progress | Runtime/package/platform spike receipt | Native adapter and focused renderer tests exist; canonical platform/PTTY proof absent | Octocode maintainers | Run native-asset, PTY, restoration, accessibility, performance, and platform matrix |
| 3. Create agent core/contracts | In review | Package, schemas, boundary receipt | Agent core passes 98 tests plus typecheck, lint, and build | Octocode maintainers | Full adapter/schema drift and entry-gate review |
| 4. Extract registries/lifecycle/policy | In progress | Pi-backed canonical conformance | Canonical units, Pi adapters, and native policy composition pass the 1,760-test Pi suite and root validation | Octocode maintainers | Complete hooks/plugins and the security conformance matrix |
| 5. Implement sessions/prompt/compaction | In progress | Migration/replay/corruption receipt | Durable sessions and prompt composition now include a production replacement-runtime router, parent/child lineage navigation, and composed manual/threshold compaction with cancellation, bounded failure handling, persistence, and restart recovery | Octocode maintainers | Complete import and overflow behavior, then run replay, corruption, restart, compaction, and source-hash suites |
| 6. Compose native runtime | In review | Native conformance/performance receipt | The native package passes 561 tests with 16 expected skips across runtime, model, transports, sessions, MCP/Skills, workers, hooks, settings, extensions, terminal, and coordination surfaces | Octocode maintainers | Run real-provider, fault/effect, and performance parity |
| 7. Build hooks/plugins | In progress | Codex compatibility and plugin security receipt | Native controller composes contained discovery, persisted review/hash/grant gates, command and registry-owned MCP execution, bounded asynchronous work, lifecycle dispatch, transactional activation/rollback, owner isolation, and lease-safe unload; missing policy grants nothing | Octocode maintainers | Add exact Codex fixtures, complete formal capability policy, and run clean security proof |
| 8. Unify settings HTML | In progress | Settings/models/hooks/plugins conformance receipt | Native launcher shares one transactional settings service across runtime and browser actions; provider, MCP, Skill, plugin review/grant, and portable export/import/reset mutations are typed, revision-safe, redacted, and trust checked | Octocode maintainers | Complete remaining configuration writers, native/Pi conformance, and the full browser/security/accessibility suite |
| 9. Build OpenTUI terminal | In progress | Renderer/PTTY/accessibility/restoration receipt | Native adapter, typed reducer, dedicated semantic widgets, single-reader input, ask/plan flows, accessible output, and one real pseudo-terminal exact-restoration smoke pass | Octocode maintainers | Remove or support the Node 26 experimental-FFI requirement and run the full terminal/platform matrix |
| 10. Canary and compare | Not started | Signed before/after expansion decision | Pending | Octocode maintainers | Steps 0–9 |
| 11. Remove native Pi dependencies | In review | Zero-reference candidate artifact | Focused native guard passes; transitive Pi path, pack/dependency-tree proof, and prerequisite canary remain open | Octocode maintainers | Resolve transitive packaging and complete release gates |
| 12. Delete the Pi oracle and close the compatibility window | Not started | Native-only rollback, package deletion, install/upgrade, and final closure receipt | Pending | Octocode maintainers | Step 11 plus approved observation window and every `A-*`/parity gate |

The checkboxes and stop conditions in `STEPS.md` remain authoritative. Update both files in the same change when a step state changes.

## Feature progress

Feature IDs and acceptance outcomes live in `READINESS_AND_FEATURE_MATRIX.md`.

| Group | Total | Complete | In progress | Blocked | Not started | Current maturity summary |
|---|---:|---:|---:|---:|---:|---|
| R — Runtime/architecture | 15 | 0 | 0 | 0 | 15 | Native seams plus composite effect/receipt contracts exist; external tool authority, complete ambient-capability injection, context governance, and routing remain unproven |
| T — Tools/commands/resources/transports | 16 | 0 | 0 | 0 | 16 | ACP v1 stdio, MCP lifecycle/progress, and native transports exist; real-editor conformance, elicitation/provenance, deferred discovery, and semantic maps remain open |
| S — Sessions/persistence/context | 10 | 0 | 0 | 0 | 10 | Durable production sessions, lineage navigation, and compaction are composed; import and complete migration/corruption/crash proof remain |
| H — Hooks/events | 14 | 0 | 0 | 0 | 14 | Existing Pi composer/listeners plus complete target specification |
| P — Extensions/plugins | 19 | 0 | 0 | 0 | 19 | Target specification only |
| U — Terminal/settings experience | 16 | 0 | 0 | 0 | 16 | OpenTUI widgets are composed; checkpoint review and complete PTY/settings evidence remain open |
| A — Agents/messaging/orchestration | 8 | 0 | 7 | 0 | 1 | Native addressed messaging, worker supervision, persistent RPC control, safe owned-orphan recovery, approval/session-bound worker JSONL projection, and real multi-process conformance are composed; ACP-specific projection, scheduler/worktrees, and clean release evidence remain open |
| Q — Compatibility/verification/release | 10 | 0 | 0 | 0 | 10 | Test/gate design exists; execution evidence pending |
| **Total** | **108** | **0** | **7** | **0** | **101** | No target feature has passed its completion gate; requested runtime surfaces now have dirty-tree evidence, with release-critical limitations explicitly retained |

When implementation begins, add a feature-detail table only for IDs whose state differs from their group. Do not duplicate all 108 definitions here.

## Current blockers

| ID | Blocker | Severity | Owner | Resolution evidence | State |
|---|---|---:|---|---|---|
| B-01 | Canonical before commit not established | Critical | Octocode maintainers | `evidence/before-<commit>.md` produced from the selected candidate with independent sign-off | Open; in progress — candidate `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` is selected, but clean capture and sign-off remain |
| B-02 | Runtime/session/security/extensions/terminal/settings/testing/release owners not assigned | Critical | Octocode maintainers | `evidence/stage-0-approval-record.md` | Closed — all 12 roles assigned; security/testing/release require independent subagent verification |
| B-03 | Agent-core workspace does not exist | High | Octocode maintainers | Approved package manifest and boundary checks | Closed for the dirty-tree candidate — package exists and focused verify/boundary tests pass |
| B-04 | Native session encoding/store decision unresolved | Critical | Octocode maintainers | Prototype and corruption benchmark decision | Open |
| B-05 | Temporary Pi oracle artifact/version matrix not pinned | High | Octocode maintainers | Frozen artifact/version policy and baseline matrix | Open; exact initial `0.84.2` policy exists, but the immutable oracle identity, complete baseline coverage, and deletion evidence-retention plan remain pending |
| B-06 | Codex hook compatibility version/fixtures not pinned | High | Octocode maintainers | Dated official-schema fixture receipt | Open |
| B-07 | Plugin capability/trust policy not approved | Critical | Octocode maintainers | Security approval and negative matrix | Open; implementation fails closed with exact-hash review and explicit grants, but the formal capability policy, settings grant workflow, and clean security approval remain |
| B-08 | OpenTUI runtime/native-package route not approved | Critical | Octocode maintainers | Supported-platform spike receipt | Open; in progress — one macOS/Node 26 experimental-FFI PTY restoration smoke pass exists, but the canonical clean package/assets and supported-platform matrix remain absent |
| B-09 | Canary thresholds and observation window unset | High | Octocode maintainers | Release policy receipt | Open before Stage 6 |

`PREREQUISITES.md` and `READINESS_AND_FEATURE_MATRIX.md` own blocker requirements. This table owns current state and assignment.

## Evidence index

| Evidence | State | Path | Produced by |
|---|---|---|---|
| RFC validation | Complete | `KPI.md` §Draft validation receipt | RFC drafting |
| Working-tree semantic Pi inventory | Complete | `evidence/stage-0-semantic-inventory.md` | Verified Awareness task `task_b456416fb4b34b46bdde148f`; non-canonical snapshot spanning `56c572c` to `b7a3b42` |
| Working-tree executable baseline | Complete | `evidence/stage-0-test-baseline.md` | Verified Awareness task `task_ed4b7920a08a45eca8ab8145`; non-canonical receipt at `56c572c` |
| Stage 0 approval packet | Complete | `evidence/stage-0-approval-packet.md` | Verified Awareness task `task_905a6f2169bb4aac927ee5c7`; packet complete, while B-01/B-02 remain open pending user approval and canonical evidence |
| Canonical before | Not started | `evidence/before-<commit>.md` | Stage 0 |
| OpenTUI working-tree route proof | Complete | `evidence/opentui-route-working-tree.md` | Verified Awareness task `task_99d390097a3c4ebb8eae2f63`; HOLD receipt at `3188378` |
| OpenTUI route decision packet | Complete | `evidence/opentui-route-decision-packet.md` | Verified Awareness task `task_2eb4a47862614d979b207bdc`; decision preparation complete, while B-08 remains open pending approval and a canonical route receipt |
| Canonical OpenTUI route | Not started | `evidence/opentui-route-<commit>.md` | Step 2 approval gate |
| Supported Pi version investigation | Complete | `evidence/pi-version-matrix-working-tree.md` | Verified Awareness task `task_77074dd2b24246009ef64b8b`; investigation complete, while B-05 remains open pending policy approval and a real multi-version matrix |
| User-authority decision summary | Complete | `evidence/NEXT_DECISIONS.md` | Integrates only choices from the verified packets; unanswered choices default to HOLD and close no blocker |
| Stage 0 bounded approval record | Complete | `evidence/stage-0-approval-record.md` | Records user-approved scope, owners, candidate preparation, Pi policy, bounded OpenTUI spike, deferred final decisions, and no-removal/no-rollout limits |
| Full execution authority and dirty-tree implementation | In review | `evidence/implementation-run-2026-08-27-b7a3b42.md` | Records the later explicit full-execution instruction, implemented surfaces, focused passing checks, independent failures, rollback, and unresolved external gates |
| Sequential prompt and ecosystem audits; exhaustive 108-ID ledger | Complete for the dirty-tree audit; release remains HOLD | `evidence/prompt-audit-2026-08-28.md`; `evidence/coding-agent-landscape-2026-08-28.md` | Architecture, context-efficiency, Pi-parity, competitor/protocol research, AST/LSP receipts, feature counts, and external gates |
| Headless runtime evaluation | Accepted dirty-tree increment; release remains HOLD | `evidence/headless-runtime-eval-2026-08-28.md` | Built text/JSON/piped/RPC/Skill-loop receipts, prompt composition, catalog caching, MCP pagination, Skill containment, and remaining limits |
| Agentic flow hardening | Accepted dirty-tree increment; release remains HOLD | `evidence/agentic-flow-hardening-2026-08-28.md` | TDD receipts for model-loop bounds, provider failures, session replay, MCP confinement and pagination, cache isolation, Skill discovery, full workspace checks, FFI, and built headless smoke |
| Agent loop, cache, and discovery hardening | Accepted dirty-tree increment; release remains HOLD | `evidence/agent-loop-cache-discovery-2026-08-28.md` | TDD receipts for message identity, validation-before-persistence, frozen prompt/tool prefixes, cache routing and telemetry, RPC backpressure, MCP error/TTL semantics, hierarchical discovery, and Skill trust |
| Architecture and protocol reuse | Accepted dirty-tree increment; release remains HOLD | `evidence/architecture-protocol-reuse-2026-08-28.md` | Orchestrated prompt audits, upstream SDK/protocol decisions, direct-import cleanup, OpenTUI cycle removal, shared path ownership, and an executable turn deadline |
| Native settings control center | Accepted bounded dirty-tree increment; release remains HOLD | `evidence/settings-control-center-2026-08-28.md` | Central slash-command catalog, secure loopback page, allowlisted theme/default-model mutation, desktop/mobile browser checks, headless regression checks, and documented remaining settings gaps |
| Native worker orchestration | Accepted dirty-tree increment; release remains HOLD | `evidence/native-worker-orchestration-2026-08-28.md` | Core supervisor, persistent RPC adapter, capability and prompt boundary, policy-bound tool, canonical Awareness ledger, package/root verification, and built parent/child RPC inventory smokes |
| Real runtime surfaces | Accepted dirty-tree increment; release remains HOLD | `evidence/real-runtime-surface-eval-2026-08-28.md` | Owned-orphan recovery, session/approval-bound worker projection, Anthropic adapter, command hook dispatch, plugin activation, real browser settings checks, one-host PTY restoration, and 3,407 passing root tests |
| Integrated runtime closure | Accepted dirty-tree increment; release remains HOLD | `evidence/integrated-runtime-closure-2026-08-28.md` | Production session routing and automatic compaction, MCP/Skill lifecycle and settings controls, command/MCP/async hooks, dynamic RPC/ACP worker projection and permission bridge, provider loopback conformance, in-app browser actions, PTY restoration, and 3,484 passing root tests |
| Documentation consolidation | Complete for the current active pack; release remains HOLD | `evidence/documentation-consolidation-2026-08-28.md` | Canonical ownership, duplicate removal, current-state reconciliation, and link/style/contradiction validation |
| Per-stage receipts | Not started | `evidence/stage-<n>-<commit>.md` | Stages 1–7 |
| Canonical after | Not started | `evidence/after-<commit>.md` | Step 10 |
| Before/after comparison | Not started | `evidence/comparison-<before>-<after>.md` | Step 10 |
| Rollback rehearsal | Not started | `evidence/rollback-<commit>.md` | Before native default/removal |
| Final closure | Not started | `evidence/closure-<commit>.md` | Step 12 |

Future filenames are templates, not claims that evidence exists.

## Update protocol

Every progress update must:

1. record the date, named commit, and dirty-state summary;
2. change only states supported by linked evidence;
3. update stage, step, feature-group/detail, blocker, and evidence tables together when applicable;
4. link exact commands, tests, fixture hashes, differences, and approvals in the receipt rather than expanding this page with raw logs;
5. preserve zero-tolerance failures even if an aggregate score improves;
6. recalculate readiness through `READINESS_AND_FEATURE_MATRIX.md` rules;
7. run RFC structure/style validation and update `KPI.md` when the document set or status schema changes.

## Change log

| Date | Change | Evidence/decision |
|---|---|---|
| 2026-08-27 | Created canonical status page; initialized all target stages, steps, 92 feature IDs, blockers, and evidence paths | Repository inventory and validated RFC document set; implementation has not begun |
| 2026-08-27 | Added and validated `README.md` as the human/agent entry point and document-routing guide | 17-file style, evaluator, link, document-map, and tracker-structure checks passed; implementation has not begun |
| 2026-08-27 | Started orchestrated pre-Stage 0 evidence work through three non-overlapping Awareness tasks | Semantic inventory, executable dirty-tree baseline, and OpenTUI route proof are in progress; canonical baseline and Pi removal remain blocked |
| 2026-08-27 | Integrated and independently checked all three opening working-tree receipts | Dependencies are DONE and verified; semantic counts and focused tests were reproduced at `b7a3b42`; different moving-HEAD snapshots remain explicitly non-canonical, so Pre-Stage 0, Step 0, all nine blockers, and the no-removal decision remain unchanged |
| 2026-08-27 | Started the second pre-Stage 0 decision-preparation wave | Separate Awareness agents are preparing the owner/baseline approval packet, OpenTUI route decision, and supported Pi-version matrix; no approval or production implementation is implied |
| 2026-08-27 | Integrated and independently checked the second decision-preparation wave | All three dependency tasks are DONE and verified; their packet rows are complete, `NEXT_DECISIONS.md` contains the remaining user-authority choices, and Pre-Stage 0, Step 0, B-01/B-02/B-05/B-08, every other blocker, and the no-removal decision remain unchanged |
| 2026-08-27 | Recorded the RFC decision owner's bounded approval and all 12 owner-role assignments without Awareness workflow requirements | `evidence/stage-0-approval-record.md`; B-02 closed, while B-01/B-05/B-08 moved to active preparation and Pre-Stage 0, Step 0, HOLD, no-removal, and no-rollout remain |
| 2026-08-27 | Recorded the later explicit instruction to execute the entire RFC with subagents and the resulting dirty-tree implementation candidate | `evidence/implementation-run-2026-08-27-b7a3b42.md`; Step 0 and B-03 close, implementation steps move to in-progress/review, full root test/build/lint/typecheck, Pi-extension, native pack, guard, and CLI/RPC checks pass; real-host conformance, platform, canary, observation-window, and release gates remain HOLD |
| 2026-08-28 | Reassessed the native-only end state, retained Pi as a temporary oracle, and defined the missing migration selector contract | Native-editor implementation readiness is 6/10 and Pi-retirement readiness is 2/10; the current launcher remains native-only, so `pi|shadow|native` selection is explicit gated release work rather than a claimed capability |
| 2026-08-28 | Reconciled the full 30-document active design pack against the native candidate and native-only product decision | Active permanent-Pi promises and stale current-state claims removed; Pi is a frozen bounded oracle followed by complete deletion; 30-file link check, strict warning/error style check, diff check, 13 documentation-consistency tests, and 23 native launcher/runtime tests pass |
| 2026-08-28 | Added current coding-agent and protocol research with AST/LSP proof | Feature authority expands from 100 to 108 IDs: context governance, hierarchical discovery, model routing, ACP, deferred tool discovery, semantic code maps, MCP durable tasks, and checkpoint review. All eight are declared, release remains HOLD, and A2A is deferred. |
| 2026-08-28 | Composed bounded native worker orchestration and its canonical lifecycle ledger | `evidence/native-worker-orchestration-2026-08-28.md`; four additional orchestration requirements move to partial, root verification passes with 3,348 tests and 16 skips, and release remains HOLD pending real two-process restart/orphan/worktree/editor evidence. |
| 2026-08-28 | Hardened and exercised the native headless runtime | `evidence/headless-runtime-eval-2026-08-28.md`; five built-command scenarios, 44 focused tests, root build/lint/typecheck, and 3,196 passing root tests verify governed prompt composition, piped input, JSON/RPC envelopes, one-process catalog loading, MCP pagination/cache behavior, Skill support-file reads, and cached-token telemetry. Release remains HOLD. |
| 2026-08-28 | Closed late shared-tree verification regressions | OpenTUI FFI passes 15/15, model-ordering and transport tests pass 9/9, Pi plan compensation passes 26/26, Awareness passes 983 tests with coverage, and hook receipt telemetry now models OpenCode without widening install-host authority. |
| 2026-08-28 | Hardened the agentic runtime and replay boundaries through TDD | `evidence/agentic-flow-hardening-2026-08-28.md`; root build/lint/typecheck, 3,220 passing tests, OpenTUI FFI 15/15, and a built headless SSE smoke pass. Responses, retry ownership, compaction, MCP 2026 tasks/cache semantics, stale writer leases, and release gates remain open. |
| 2026-08-28 | Composed authoritative tool lifecycle decisions and persistent MCP session ownership | `evidence/architecture-protocol-reuse-2026-08-28.md`; rewrites now survive resume, deny/stop precede effects, context persists once, MCP connections reuse and invalidate catalogs through negotiated notifications, concurrent shutdown shares one barrier, and root tests pass. Responses, worker/mailbox composition, ACP, broader lifecycle interception, MCP Tasks, real-host conformance, and release gates remain open. |
| 2026-08-28 | Added official Responses and ACP adapters and completed input/context authority | Exact dependency pins are `openai@7.8.0`, `@agentclientprotocol/sdk@1.4.0`, and `zod@4.4.3`. Typed Responses streaming, cache read/write telemetry, ACP v1 runtime/stdin bridging, ordered MCP progress, and durable deny/stop input parity pass focused tests. Worker/mailbox composition, MCP elicitation/provenance, live-provider/editor conformance, and every release gate remain open. |
| 2026-08-28 | Added the bounded native settings control-center slice and reconciled its documentation | `evidence/settings-control-center-2026-08-28.md`; `/settings [section]`, protected local serving, allowlisted next-session mutations, and browser/headless checks pass. The canonical registry, complete Models/Hooks/Plugins workflows, native/Pi conformance, and every release gate remain open. |
| 2026-08-28 | Closed private context disclosure in native JSON and RPC events | A versioned public-event projection replaces `context.preparing.messages` with a message count before serialization; focused JSON/RPC regressions prove system and repository instructions are absent. Release remains HOLD. |
| 2026-08-28 | Verified the requested real runtime surfaces and raised native implementation readiness to 8.5/10 | `evidence/real-runtime-surface-eval-2026-08-28.md`; 3,407 root tests pass with 16 expected skips, including owned-orphan recovery, worker projection, provider adapters, command hooks, plugin activation, browser settings, and one-host PTY restoration. Credentialed providers, ACP-specific workers, complete settings/hooks, clean packaging, platform matrices, and release gates remain open. |
| 2026-08-28 | Consolidated the active design pack around canonical owners | `evidence/documentation-consolidation-2026-08-28.md`; removed the redundant root hooks/plugins and leftovers pages, replaced the duplicate backlog with a dependency index, reconciled the audit/readiness/status/spec pages, and preserved every pre-existing dated evidence receipt unchanged. Release remains HOLD. |
| 2026-08-28 | Integrated the session, compaction, MCP/Skill, hook/settings, and RPC/ACP worker lanes | `evidence/integrated-runtime-closure-2026-08-28.md`; root tests pass 3,484 with 16 expected native skips, build/lint/typecheck pass, built CLI and Octocode discovery smokes pass, in-app browser capability mutations pass, and macOS PTY restoration passes with experimental FFI. Clean-candidate and external release gates remain HOLD. |
