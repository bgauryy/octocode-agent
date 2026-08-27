# Migration status: Remove `pi-coding-agent`

Last updated: 2026-08-27
Overall state: **Dirty-tree implementation candidate under verification**
Active stage: **Stages 0–5 and native dependency-removal work overlap; no release stage gate is closed**
Release decision: **HOLD — do not canary, publish, or declare migration complete**

> This file is the canonical progress ledger. `RFC.md` owns scope and decisions. `STEPS.md` owns execution order. `MIGRATION_STAGES.md` owns gates and rollback. `READINESS_AND_FEATURE_MATRIX.md` owns maturity definitions and feature IDs. `KPI.md` and `TEST_PLAN.md` own pass/fail rules. A status update cannot weaken those documents.

## Executive status

| Signal | Current state | Evidence | Next transition |
|---|---|---|---|
| RFC document set | Validated draft | 17 documents including the agent guide; final validation receipt in `KPI.md` | Reviewer accepts scope and owners |
| RFC/design completeness | 9/10 | `READINESS_AND_FEATURE_MATRIX.md` | Close ownership and baseline blockers |
| Ready to start Stage 0/1 | 7/10 | `READINESS_AND_FEATURE_MATRIX.md` | Select canonical before commit and owners |
| Target implementation completeness | Implemented candidate; gate score not yet recalculated | `evidence/implementation-run-2026-08-27-b7a3b42.md`; agent core/native runtime/transports/OpenTUI/Pi adapters exist in a dirty tree | Finish production composition and required conformance/security/platform suites |
| Native canary readiness | 0/10 | Focused native tests pass, but production composition and external matrices are incomplete | Reach every Stage 5 exit gate on a committed candidate |
| Dependency-removal readiness | Focused static guard passes; release gate remains open | Native source/direct manifest/built-JS scan passes, but the native manifest still reaches Pi transitively through the retained extension and packed-artifact proof is absent | Remove or classify the transitive path and complete Stage 6 observation/rollback evidence |
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
| 1. Contracts | In review | Stage 0 complete | Agent-core package, contracts, Pi adapter, dependency proof | Dirty-tree package and focused verification in `evidence/implementation-run-2026-08-27-b7a3b42.md` | Octocode maintainers | Run a clean post-fix full Pi suite/conformance matrix and close the entry gate |
| 2. Kernel surfaces | In progress | Stage 1 contract suite passes | Registries, lifecycle, hooks/plugins, policy, helpers | Implemented units/adapters exist; production native composition is incomplete | Octocode maintainers | Wire production composition and run full security/conformance matrix |
| 3. Sessions | In progress | Stage 2 complete; store decision approved | Native store, Pi importer, projection, compaction | Native store/importer/compaction source and focused tests exist | Octocode maintainers | Approve store decision and run full migration/corruption corpus |
| 4. Runtime | In review | Stage 3 corpus passes | Native model/tool loop and pure shadow proof | Native kernel/model/transports pass focused tests; the shared harness now encodes all 14 canonical scenarios with trace/effect comparison | Octocode maintainers | Bind real Pi/native adapters and complete production composition, shadow/effect, fault, and performance proof |
| 5. Transports/UI/settings | In progress | Stage 4 plus OpenTUI route passes | Native modes, OpenTUI, settings/models/hooks/plugins | Native transports/OpenTUI and focused settings tests exist; HTML and PTY/platform gates incomplete | Octocode maintainers | Finish semantic settings UI, interactions, accessibility, PTY/platform matrices |
| 6. Native default | Not started | Stage 5 complete; thresholds and rollback approved | Canary/default receipts and observation metrics | Pending | Octocode maintainers | Stage 5 and release policy |
| 7. Dependency removal | In review | Observation window passes | Zero native Pi dependency and supported extension proof | Focused native source/direct-manifest/built-JS guard passes; transitive Pi path and release evidence remain | Octocode maintainers | Complete Stage 6, packed/dependency graph proof, extension matrix, and artifact rollback |

Stage details, entry/exit criteria, and rollback remain in `MIGRATION_STAGES.md`.

## Step tracker

| Step | State | Deliverable | Evidence | Owner | Next action |
|---:|---|---|---|---|---|
| 0. Approve scope and owners | Complete | Accepted scope/owner receipt | `evidence/stage-0-approval-record.md` plus explicit user instruction to execute the full RFC with subagents | Octocode maintainers | Preserve scope: native Pi removal, supported Pi extension retained |
| 1. Freeze before baseline | In progress | Canonical before receipt and fixture corpus | Detached before receipt exists but remains HOLD/non-canonical | Octocode maintainers | Complete fixture/hash/matrix values and independent sign-off |
| 2. Prove OpenTUI route | In progress | Runtime/package/platform spike receipt | Native adapter and focused renderer tests exist; canonical platform/PTTY proof absent | Octocode maintainers | Run native-asset, PTY, restoration, accessibility, performance, and platform matrix |
| 3. Create agent core/contracts | In review | Package, schemas, boundary receipt | Agent-core verify passed 7 files/23 tests plus typecheck/build | Octocode maintainers | Full adapter/schema drift and entry-gate review |
| 4. Extract registries/lifecycle/policy | In progress | Pi-backed canonical conformance | Canonical units and Pi adapters exist; post-fix focused rerun passed 7 files/145 tests, but no clean full-suite rerun exists | Octocode maintainers | Run the full suite and wire native production composition |
| 5. Implement sessions/prompt/compaction | In progress | Migration/replay/corruption receipt | Implementations and focused tests exist; required corpus/decision absent | Octocode maintainers | Run import, replay, corruption, restart, compaction, and source-hash suite |
| 6. Compose native runtime | In review | Native conformance/performance receipt | Native runtime/model/transports and shared harness focused suites pass | Octocode maintainers | Wire all implemented services; run fault/effect/performance parity |
| 7. Build hooks/plugins | In progress | Codex compatibility and plugin security receipt | Canonical hook/plugin code and Pi adapters exist | Octocode maintainers | Exact Codex fixtures, trust/security, transactional unload, and leak proof |
| 8. Unify settings HTML | In progress | Settings/models/hooks/plugins conformance receipt | Settings contracts/service and focused HTML tests exist; sections remain incomplete/static | Octocode maintainers | Complete registry-driven page and browser/security/accessibility suite |
| 9. Build OpenTUI terminal | In progress | Renderer/PTTY/accessibility/restoration receipt | Native adapter/reducer/renderer and focused tests exist | Octocode maintainers | Implement required input/interactions and run real PTY/platform matrix |
| 10. Canary and compare | Not started | Signed before/after expansion decision | Pending | Octocode maintainers | Steps 0–9 |
| 11. Remove native Pi dependencies | In review | Zero-reference candidate artifact | Focused native guard passes; transitive Pi path, pack/dependency-tree proof, and prerequisite canary remain open | Octocode maintainers | Resolve transitive packaging and complete release gates |
| 12. Close compatibility window | Not started | Final closure receipt | Pending | Octocode maintainers | Step 11 plus approved window |

The checkboxes and stop conditions in `STEPS.md` remain authoritative. Update both files in the same change when a step state changes.

## Feature progress

Feature IDs and acceptance outcomes live in `READINESS_AND_FEATURE_MATRIX.md`.

| Group | Total | Complete | In progress | Blocked | Not started | Current maturity summary |
|---|---:|---:|---:|---:|---:|---|
| R — Runtime/architecture | 12 | 0 | 0 | 0 | 12 | Specification plus reusable current seams; target core absent |
| T — Tools/commands/resources/transports | 12 | 0 | 0 | 0 | 12 | Current Pi inventory exists; canonical/native path absent |
| S — Sessions/persistence/context | 10 | 0 | 0 | 0 | 10 | Requirements only; store decision pending |
| H — Hooks/events | 14 | 0 | 0 | 0 | 14 | Existing Pi composer/listeners plus complete target specification |
| P — Extensions/plugins | 19 | 0 | 0 | 0 | 19 | Target specification only |
| U — Terminal/settings experience | 15 | 0 | 0 | 0 | 15 | Existing settings page is reusable; OpenTUI has only an isolated runtime smoke, not a repository adapter |
| Q — Compatibility/verification/release | 10 | 0 | 0 | 0 | 10 | Test/gate design exists; execution evidence pending |
| **Total** | **92** | **0** | **0** | **0** | **92** | No target feature has passed its completion gate |

When implementation begins, add a feature-detail table only for IDs whose state differs from their group. Do not duplicate all 92 definitions here.

## Current blockers

| ID | Blocker | Severity | Owner | Resolution evidence | State |
|---|---|---:|---|---|---|
| B-01 | Canonical before commit not established | Critical | Octocode maintainers | `evidence/before-<commit>.md` produced from the selected candidate with independent sign-off | Open; in progress — candidate `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` is selected, but clean capture and sign-off remain |
| B-02 | Runtime/session/security/extensions/terminal/settings/testing/release owners not assigned | Critical | Octocode maintainers | `evidence/stage-0-approval-record.md` | Closed — all 12 roles assigned; security/testing/release require independent subagent verification |
| B-03 | Agent-core workspace does not exist | High | Octocode maintainers | Approved package manifest and boundary checks | Closed for the dirty-tree candidate — package exists and focused verify/boundary tests pass |
| B-04 | Native session encoding/store decision unresolved | Critical | Octocode maintainers | Prototype and corruption benchmark decision | Open |
| B-05 | Supported Pi-version matrix not pinned | High | Octocode maintainers | Version policy and adapter matrix | Open; in progress — exact initial `0.84.2` policy approved, complete admission/rejection and platform evidence pending |
| B-06 | Codex hook compatibility version/fixtures not pinned | High | Octocode maintainers | Dated official-schema fixture receipt | Open |
| B-07 | Plugin capability/trust policy not approved | Critical | Octocode maintainers | Security approval and negative matrix | Open |
| B-08 | OpenTUI runtime/native-package route not approved | Critical | Octocode maintainers | Supported-platform spike receipt | Open; in progress — bounded Node 26.4.0/OpenTUI 0.5.8 spike approved, but canonical package, PTY, asset, and platform evidence remain absent |
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
