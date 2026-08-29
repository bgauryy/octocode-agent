# Success and verification: Remove `pi-coding-agent`

> Verifies `RFC.md` §Goals and non-goals and the build in `IMPLEMENTATION.md`. `STATUS.md` owns current progress; `READINESS_AND_FEATURE_MATRIX.md` owns maturity ratings and feature IDs; `STEPS.md` owns operational order; `BEFORE_AFTER.md` owns comparison detail; `SCHEMAS_AND_TYPES.md` owns contract shape and Pi mappings; `HOOKS_AND_PLUGINS.md` owns Codex hooks and event-driven plugins; `OPENTUI_TERMINAL_CORE.md` owns native terminal acceptance; `SETTINGS_WEB_UI.md` owns settings/models/hooks/plugins acceptance; `TEST_PLAN.md` owns mandatory execution.

## User stories

- As an Octocode user, I want sessions and tools to behave consistently through the migration, so runtime ownership changes are invisible unless they improve reliability. → Goals 1, 3, 5
- As an Octocode maintainer, I want small runtime capabilities and one conformance suite, so I can change hosts without reconstructing implicit Pi behavior. → Goals 1, 4, 6
- As an interactive terminal user, I want a native OpenTUI frontend with reliable input, streaming, resize, accessibility, and restoration, so removing Pi improves ownership without degrading terminal behavior. → Goals 3, 5, 7
- As a user configuring Octocode, I want every supported setting and model source in one safe HTML page, so I can understand effective values and change `models.json` without hidden precedence, corruption, or secret exposure. → Goals 3, 4, 5, 8
- As a security reviewer, I want one fail-closed policy boundary across every transport, so a new runtime cannot bypass trust, approval, plan-mode, or peer-lock enforcement. → Goal 3
- As a release owner, I want measured canary and rollback gates, so dependency deletion is evidence-based and reversible. → Goals 2, 5
- As an integration author, I want versioned events and RPC schemas, so clients depend on Octocode contracts rather than Pi internals. → Goals 1, 4
- As an extension author, I want Codex-compatible hooks and typed event-driven plugin contributions, so integrations survive host removal without receiving unrestricted runtime authority. → Goals 1, 4, 5, 9

## Acceptance criteria

```gherkin
Feature: Runtime host conformance
  Scenario: The same tool flow runs on both hosts
    Given the Pi and native adapters receive the same deterministic script
    When a tool is registered, policy-checked, updated, completed, and rendered
    Then normalized event order, result, cancellation, and error semantics match

  Scenario: Policy blocks before execution
    Given an untrusted, plan-restricted, or peer-locked mutation
    When any transport requests the tool
    Then the policy denies it before side effects and emits one auditable receipt

  Scenario: Existing session migrates safely
    Given a representative Pi JSONL session with branches, custom entries, and compaction
    When it is imported into a new native session
    Then the transcript, branch projection, durable entries, and approved prompt context match
    And the original Pi session remains unchanged

  Scenario: Runtime abort owns all child work
    Given a streaming turn with a tool process and background activity
    When the operator aborts the runtime
    Then the turn reaches one terminal state and no owned child remains running

  Scenario: Native runtime is removed from Pi coding-agent
    Given the Phase 6 candidate artifact
    When native agent/core imports, package resolution, subprocesses, and dependency graph are inspected
    Then no native agent/core path references @earendil-works/pi-coding-agent
    And any remaining live Pi references are confined to the frozen oracle before retirement

  Scenario: Pi oracle is bounded and retired
    Given a pinned Pi host version during the comparison window
    When @octocodeai/pi-extension activates through agent-core contracts
    Then its semantic conformance suite passes
    And agent core has no dependency on Pi or the extension
    And after the signed retirement gate no live Pi package, selector, workflow, or product path remains

  Scenario: Native terminal uses OpenTUI safely
    Given the accepted OpenTUI runtime and native artifact route
    When an interactive session starts, streams, resizes, accepts input, cancels, and exits
    Then semantic UI behavior and approved performance match the baseline
    And the terminal is restored for normal, error, signal, and failed-start paths
    And no OpenTUI type crosses into agent core or a noninteractive transport

  Scenario: All settings and models use one HTML control center
    Given the native agent or the frozen Pi oracle during comparison
    When the user opens /settings models and changes a default or models.json source
    Then settings.html shows the stored and effective values with provenance
    And the mutation is schema-valid, revision-safe, atomic, and redacted
    And every supported human-facing setting renders or has an approved classification

  Scenario: Codex hooks and plugins are compatible and fail closed
    Given reviewed Codex-format hooks and a capability-scoped plugin
    When mapped lifecycle events dispatch on native and supported Pi hosts
    Then matcher, ordering, input, output, decision, and contribution receipts conform
    And changed or untrusted definitions do not execute
    And activation and unload leave no partial registry, duplicate effect, secret, process, or resource
```

## Definition of done

- [ ] All acceptance scenarios pass against the native runtime.
- [ ] Pi and native hosts pass the shared pre-cutover conformance corpus.
- [ ] Every intentional behavior difference has an approved fixture update and rationale.
- [ ] All native agent/core dependency targets reach zero; remaining extension references match the approved adapter inventory.
- [ ] Session import, replay, fork, compaction, and crash-recovery suites pass.
- [ ] Interactive, print, JSON, and RPC mode matrices pass.
- [ ] The native OpenTUI runtime/package, platform, renderer, PTY, accessibility, performance, and terminal-restoration gates pass.
- [ ] Unified `settings.html` completeness, Models/`models.json`, concurrency, recovery, accessibility, and zero-secret-exposure gates pass.
- [ ] Codex hook compatibility, plugin contribution lifecycle, exact-hash trust, host conformance, and Hooks/Plugins settings gates pass.
- [ ] Security and duplicate-effect guardrails pass with zero tolerance.
- [ ] Root build, test, typecheck, and lint pass from the selected candidate commit.
- [ ] Affected packages are rebuilt and verified through the real CLI/MCP/skill path.
- [ ] Before, after, and comparison evidence receipts exist under this RFC folder.
- [ ] Rollout completes per `IMPLEMENTATION.md` and the release owner signs the comparison.

## Before-and-after measurement protocol

Run measurements on named commits in equivalent environments. Normalize timestamps, random IDs, absolute temporary paths, provider request IDs, and secret-bearing fields before comparison. Do not normalize event order, error category, tool/command names, session ancestry, policy decisions, token counts, or exit codes.

For every metric, record:

- command/query and tool version;
- commit and dirty state;
- raw result location;
- normalized result location;
- pass/fail decision and approver;
- reason for any accepted difference.

Use the `PREREQUISITES.md` evidence receipt naming convention. A comparison without both raw receipts is invalid.

## Static measurements

| Metric | Baseline | Target | Measurement | Failure meaning |
|---|---:|---:|---|---|
| Production `pi-coding-agent` imports/type imports | Classified in 8 dependency-bearing files | 0 | Octocode source search plus AST import search | Direct compile/runtime coupling remains |
| `pi-coding-agent` package-resolution/deep-import strings | SDK, launcher, and exporter paths present | 0 | Exact source search | Hidden runtime coupling remains |
| Pi subprocess fallback | Present in launcher | 0 | LSP callers plus launcher integration test | Runtime still requires Pi |
| Production `PiInstance` references | 64 LSP refs | 0 outside supported Pi-extension adapter | LSP references | Pi host coupling escaped the adapter |
| Production `PiContext` references | 172 LSP refs | 0 outside supported Pi-extension adapter | LSP references | Pi context coupling escaped the adapter |
| Production `ToolDefinition` Pi-compatible references | 54 LSP refs | 0 duplicated canonical definitions; Pi-only adapter types allowed | LSP references and type-definition check | Tool domain contract still inherits Pi |
| Direct `pi.<method>` calls | 40 AST calls | 0 outside supported Pi-extension adapter | Structural AST search | Native product still calls Pi host |
| Pi middleware registrations | 17 composed plus direct lifecycle hooks in the inspected tree | 0 outside supported Pi-extension adapter | Structural AST, LSP, and event inventory | Native lifecycle still hosted by Pi |
| Public command inventory | 26 registrations | Same names unless approved | Registry snapshot | User command regression |
| Direct tool palette | 17 tools including overridden `bash` | Same names/schemas unless approved | Registry/schema snapshot | Model tool regression |
| Runtime contract dependency cycles | Not measured | 0 | Workspace dependency graph and cycle check | Contracts are not a leaf boundary |
| Runtime production modules outside agent core | Not measured | 0 unless explicitly classified as launcher/UI/adapter integration | Package-boundary source inventory | Runtime ownership remains fragmented |
| Duplicated canonical contract declarations in Pi extension | Broad local Pi-compatible facade | 0; Pi-only adapter types remain | Type-symbol and schema inventory | Extension can drift from agent core |
| Supported Pi-extension versions passing matrix | Capture in Phase 0 | 100% of declared versions | Adapter matrix suite | Published extension support is unproven |
| Native `pi-tui` references/dependencies | Capture in Phase 0 | 0 after OpenTUI parity | Source, AST/LSP, dependency tree, artifact inspection | Native terminal still depends on Pi |
| OpenTUI-named/proprietary types outside native terminal adapter | Existing proof types in Pi extension; freeze exact LSP inventory in Phase 0 | 0, except historical fixtures explicitly classified | Import/type-symbol inventory | Prototype contracts remained duplicated or terminal toolkit leaked into agent core/transports |
| Human-facing settings missing from `settings.html` | Inventory in Phase 0 | 0 | Registry-to-renderer completeness test | Hidden or fragmented configuration remains |
| Direct settings/model filesystem writers outside approved adapters | Launcher `settings.ts` plus current page/config stores; classify in Phase 0 | 0 unclassified | AST/LSP callers plus write-call inventory | Multiple mutation paths can drift or corrupt state |
| Settings/model secret exposures | 0 | 0 | Synthetic-marker scan of HTML, DOM state, payloads, logs, diffs, backups, receipts | Privileged settings page leaks credentials |
| Declared model sources with unknown provenance/revision | Capture in Phase 0 | 0 | `ModelSourceDescriptor` snapshot | User cannot explain effective catalog or write conflicts |
| Production-used Pi listeners without canonical mapping | Capture composed/direct runtime inventory in Phase 0 | 0 | AST candidates plus LSP/runtime trace proof | Host removal drops or approximates behavior |
| Supported Codex hook fixtures failing | Establish dated official-schema fixture corpus | 0 failures for declared compatibility version | JSON/TOML parser and host-conformance suites | Codex format claim is false or drifted |
| Plugin contributions outside canonical registries | Capture Phase 0 | 0 | AST/LSP registry mutation inventory | Plugin can bypass lifecycle, policy, or unload |

Static query templates:

```text
npx octocode tools localSearchCode --queries '<production Pi import/search query>' --compact
npx octocode tools localSearchCode --queries '<structural pi.$METHOD($$$ARGS) query>' --compact
npx octocode tools lspGetSemantics --queries '<PiInstance/PiContext/ToolDefinition references query>' --compact
```

Store the exact expanded JSON queries in the evidence receipt. Templates are intentionally not treated as proof.

## Behavioral equivalence matrix

| Surface | Before capture | After check | Pass rule |
|---|---|---|---|
| Startup/shutdown | Ordered lifecycle trace | Native trace | Same required order and one terminal shutdown |
| Input | interactive, RPC, extension; steer/follow-up | Same scripts | Same transforms, handling, and queue behavior |
| Agent/turn | start/end plus usage and stop reason | Same scripts | Required fields and ordering match |
| Tool | call gate, start, updates, end, result/error | Same tool corpus | Same policy/result semantics; no duplicate effects |
| Commands | names, descriptions, completions, execution | Registry and scenarios | Inventory match or approved removal |
| Model control | selection and thinking changes | Adapter scenarios | Same accepted/rejected transitions |
| Messages | user/custom/durable entry behavior | Transcript projection | Same model-visible versus display-only classification |
| Sessions | new/resume/switch/fork/tree/name/export | Fixture corpus | Same ancestry and content projection |
| Compaction | manual/threshold/overflow/retry/error | Fault matrix | One terminal state; no durable-state loss |
| UI | dialogs, status, widget, title, editor, working state | Semantic event assertions | Critical events present; supported degradation documented |
| Native terminal renderer | Pi terminal baseline plus semantic fixtures | OpenTUI projection, test-renderer frames, and real PTY matrix | Critical semantics preserved; OpenTUI types remain adapter-private; restoration always passes |
| Settings | Existing Runtime/Commands/MCP/Discovery/Agent-context/Skills/Overrides page plus launcher config | Unified registry-driven `settings.html` | Every supported setting appears/classifies; effective values and host conformance match |
| Models | Default provider/model in Pi settings; external/legacy model sources | Models section with effective catalog and safe source management | Default transaction, provenance, CRUD, import, conflict, atomicity, and redaction pass |
| Hooks | Current Pi composed/direct listeners plus dated Codex fixtures | Canonical bus and Codex adapter | Same mapped order/decisions; declared compatibility fixtures pass; exact-hash trust enforced |
| Plugins | Static Pi-extension registration paths | Transactional event-driven contribution manager | Deterministic inventory, capability enforcement, host parity, reverse unload, zero partial activation |
| Print | stdout/stderr/exit code | Golden invocation | Equivalent normalized output and exit code |
| JSON/RPC | request/response/event corpus | Protocol contract suite | Schema-valid, correlated, version-compatible |
| Cancellation | before start, streaming, tool, process, compaction | Leak/final-state checks | No owned child/open handle; one terminal event |
| Trust/security | trusted/untrusted, approval, plan, locks | Negative matrix | Zero bypass and one auditable decision |

## Session corpus

The migration corpus must include:

- empty and single-turn sessions;
- streamed text, thinking, tool call, tool result, and custom entry content;
- named sessions and artifact manifests;
- multiple branches, fork before/at entry, tree navigation, and rewind leaf lookup;
- manual and automatic compaction, overflow retry, failed retry, and post-compaction continuation;
- aborted turns and interrupted writes;
- unknown future entry types;
- malformed/truncated final records;
- non-ASCII content and large payloads;
- sessions created on each supported platform path convention.

User/private conversation contents must be synthetic or irreversibly redacted.

## Success metrics

| Metric | Type | Baseline | Target | Window | Source |
|---|---|---|---|---|---|
| Native successful session rate | Lagging | Capture before canary | No statistically meaningful regression from Pi cohort | Approved compatibility window | Redacted runtime receipts |
| Native runtime adoption | Leading | 0% | Release-owner threshold set in Q4 | Compatibility window | Host-selection receipts |
| `pi-coding-agent` production dependency count | Leading | Present | 0 | Phase 6 candidate | Static/dependency checks |
| Shared conformance pass rate | Leading | Establish Phase 0 | 100% required scenarios | Every phase | Test reports |
| Unapproved behavior diffs | Guardrail | 0 | 0 | Every phase | Golden comparison |
| Security-policy bypasses | Guardrail | 0 | 0 | Always | Negative tests and receipts |
| Duplicate external effects | Guardrail | 0 | 0 | Shadow/canary | Effect receipts |
| Unrecoverable session migrations | Guardrail | 0 | 0 | Migration and canary | Import/replay reports |
| Compaction loops or lost durable state | Guardrail | 0 | 0 | Test and canary | Runtime/session telemetry |
| Abort-owned child leaks | Guardrail | Establish Phase 0 | 0 | Test and canary | Open-handle/process checks |
| Startup and first-event latency | Guardrail | Capture p50/p95 | No approved threshold regression | Equivalent hardware window | Benchmark receipt |
| Peak memory for representative turn | Guardrail | Capture p50/p95 | No approved threshold regression | Equivalent hardware window | Benchmark receipt |
| OpenTUI first-frame and frame duration | Guardrail | Capture Pi terminal baseline and OpenTUI spike | No approved threshold regression | Equivalent runtime, hardware, dimensions, and presentation corpus | OpenTUI benchmark receipt |
| Terminal restoration failures | Guardrail | 0 | 0 | Test and canary | PTY exit/signal/crash matrix |
| Settings/model write conflicts causing lost updates | Guardrail | 0 | 0 | Test and canary | Revision/conflict/fault receipts |
| Settings/model secret leaks | Guardrail | 0 | 0 | Every generated/test/release artifact | Synthetic secret scan |
| Codex hook compatibility pass rate | Leading | Establish dated fixture corpus | 100% of declared supported fixtures | Every phase and official-schema review | Hook compatibility report |
| Untrusted/changed hook or plugin executions | Guardrail | 0 | 0 | Always | Trust audit and negative tests |
| Hook/plugin policy bypasses or duplicate effects | Guardrail | 0 | 0 | Test and canary | Decision/effect receipts |
| Partial plugin activations or unload/resource leaks | Guardrail | 0 | 0 | Test, update, shutdown, canary | Registry/process/open-handle receipts |

Performance thresholds must be filled from the clean baseline and approved before native canary. This RFC does not invent percentages without measurements.

## Decision rules

- Proceed to the next phase only when every phase-specific required check passes and no zero-tolerance guardrail fires.
- Stop rollout immediately for a security bypass, duplicate effect, unrecoverable session mismatch, protocol corruption, compaction loop, or owned-child leak.
- Stop rollout immediately for an untrusted hook/plugin execution, partial plugin activation, contribution conflict that resolves silently, or hook/plugin-owned resource leak.
- Roll back the host selector when the Pi adapter remains installed; roll back the release artifact after package removal.
- Investigate ordinary reliability or performance misses before expansion. Accept a difference only with an owner, rationale, fixture update, and user-impact assessment.
- Delete the migration Pi host selector/rollback adapter only after the Q4 observation window, adoption threshold, and prior-native rollback pass; delete the Pi extension in the same final retirement program.
- Declare RFC success only when Pi is absent from native agent/core, the extension package and live product wiring are deleted, native is stable for the approved window, clean install and upgrade pass, and the evidence comparison is signed.

## Traceability

| RFC requirement | Story | Acceptance check | Verification | Status |
|---|---|---|---|---|
| Goal 1: own runtime contracts | Maintainer/integration author | Host-neutral runtime scenarios | Dependency graph, types, contract suite | Pending |
| Goal 2: remove dependency | Release owner | Zero-reference scenario | AST/LSP/search/dependency tree | Pending |
| Goal 3: preserve/improve behavior | User/security reviewer | Behavioral and security scenarios | Golden matrix, E2E, canary | Pending |
| Goal 4: focused interfaces | Maintainer | Product modules depend on capabilities only | Type/LSP architecture checks | Pending |
| Goal 5: reversible phases | Release owner | Phase selector and rollback tests | Rollout receipts | Pending |
| Goal 6: one conformance suite | Maintainer | Same scenarios run on both hosts | Test matrix/report | Pending |
| Goal 7: native OpenTUI terminal | Terminal user/UI maintainer | OpenTUI parity, isolation, accessibility, performance, and restoration | Core test renderer plus real PTY/platform matrix | Pending |
| Goal 8: unified settings HTML and Models | User/config maintainer/security reviewer | Complete registry/page, safe model/source mutations, host parity | Completeness, schema, fault, security, browser, and E2E suites | Pending |
| Goal 9: Codex hooks and event-driven plugins | Extension author/security reviewer | Exact fixtures, mapped events, trust, transactional contributions, host parity | Schema, conformance, security, settings, lifecycle, leak suites | Pending |
| Non-goals 10-14 | Reviewers | Scope audit, including bounded Pi-oracle use and final deletion | Dependency, adapter matrix, and diff review | Pending |

## RFC document validation

Before acceptance, validate this seventeen-file set:

- [x] Every link and repository-relative path resolves.
- [x] Every current-state claim has a local source or is marked pending.
- [x] `RFC.md` alone owns goals, scope, decision, alternatives, and risks.
- [x] `PREREQUISITES.md` distinguishes observed working-tree evidence from pending canonical baselines.
- [x] `IMPLEMENTATION.md` orders work by dependency and gives every phase a proceed gate and rollback.
- [x] `KPI.md` contains outcome, leading, and guardrail metrics plus a decision rule.
- [x] Every RFC goal appears in traceability.
- [x] Every unresolved question is resolved or explicitly deferred with a trigger.
- [x] Markdown style lint has zero errors and zero warnings; informational suggestions were reviewed.
- [x] The RFC evaluator passes; the residual check is recorded later in this section.
- [x] `BEFORE_AFTER.md`, `IMPACT.md`, `MIGRATION_STAGES.md`, and `TEST_PLAN.md` link to the owning RFC requirements instead of redefining scope.
- [x] `SCHEMAS_AND_TYPES.md` assigns canonical contracts to agent core, bounds Pi-only translation to the temporary oracle, and requires final deletion.
- [x] Every execution step in `STEPS.md` cites its governing documents, output, and stop condition.
- [x] `OPENTUI_TERMINAL_CORE.md` keeps OpenTUI adapter-private and defines runtime, packaging, lifecycle, test, performance, accessibility, and rollback gates.
- [x] `SETTINGS_WEB_UI.md` defines registry completeness, the Models/`models.json` section, revision-safe mutations, source provenance, secret safety, host conformance, migration, and rollback.
- [x] `HOOKS_AND_PLUGINS.md` defines Codex format compatibility, canonical events, trust, handlers, transactional plugin contributions, settings integration, migration, rollback, and tests.
- [x] `READINESS_AND_FEATURE_MATRIX.md` separates specification, implementation, canary, and removal readiness; inventories every target feature; and qualifies sourced external comparisons.
- [x] `STATUS.md` tracks current stage, step, feature groups, blockers, owners, evidence, update rules, and change history without redefining requirements.
- [x] `README.md` explains the target shape, every document's ownership, role-based reading paths, the agent workflow, update routing, evidence rules, validation, and stop conditions.

### Draft validation receipt: 2026-08-27

| Validation | Result | Interpretation |
|---|---|---|
| Documentation style lint | Exit 0; 17 files, 0 errors, 0 warnings, and 152 informational suggestions reviewed | The complete RFC set meets the enforced documentation style gate. |
| RFC evaluator self-test | Exit 0; strong and weak samples classified correctly for all three cases | Evaluator is active. |
| RFC `existing-code-folder-rfc` evaluation | Pass; score 0.929 against a minimum of 0.85, all 12 required patterns present, and 203 explicit citation/evidence anchors under the current counting rule | The evaluator accepts the seventeen-document RFC; its remaining placeholder warning is a known false positive on TypeScript/JSON braces. |
| Concrete repository path validation | Exit 0; all referenced concrete paths exist | Future evidence paths with `<commit>` placeholders were intentionally excluded. |
| Schema/type document structure validation | Exit 0; every required contract, ownership, versioning, compatibility, and validation section is present | The new contract specification is complete enough to guide implementation and review. |
| Document/steps/readiness/status structure validation | Exit 0; 17 mapped documents, Steps 0–12, Stages 0–7, status Steps 0–12, 92 unique feature IDs, 9 blockers, every required README/status section, and 8 cross-document `STATUS.md` references | The guide, execution plan, and canonical progress ledger are complete, aligned, and mechanically countable. |
| External comparison source retrieval | Official/primary Codex, Pi, Claude Code, and OpenCode documentation opened on 2026-08-27 | Comparison claims use documented surfaces; “not established” avoids treating an unreviewed feature as absent. |
| Earlier renderer-seam suite | Exit 0; 1 file and 4 tests passed in an earlier inspected tree | This historical result covers the Pi runtime renderer, not OpenTUI. The opening route receipt at `3188378` found the RFC-named OpenTUI prototype files absent and the focused OpenTUI command exited 1 with no matching test file. |
| Existing settings HTML focused suite | Exit 0; 1 file and 5 tests passed | The current page/action/security seam is executable before generalization. |
| Existing launcher settings focused suites | Exit 0; 2 files and 20 tests passed | Current direct setting/default-model behavior is frozen as migration evidence. |
| `@octocodeai/agent-testing` focused suite | Exit 0; 1 file and 12 tests passed at the opening baseline and independent integration rerun | Candidate conformance harness works in the inspected working tree. This is not a canonical baseline. |
| Complete extension mock-host flow | Exit 0; 1 file and 1 test passed | The extension boots and exercises its public lifecycle through the structural harness. This is not a canonical baseline. |

### Initial evidence integration receipt: 2026-08-27

| Check | Observed result | Interpretation |
|---|---|---|
| Dependency acceptance | All three opening Awareness tasks are `DONE` and independently verified | The semantic, executable-baseline, and OpenTUI-route receipts satisfy their bounded task contracts. |
| Revision reconciliation | OpenTUI receipt: `3188378`; executable receipt: `56c572c`; semantic receipt: started at `56c572c` and ended at `b7a3b42`; integration rerun: clean tracked tree at `b7a3b42` | Both earlier SHAs are ancestors of `b7a3b42`. Concurrent commits advanced HEAD, so these are truthful snapshots rather than one canonical before baseline. |
| Semantic Pi invocation rerun | Octocode search: 95 `pi.<method>` calls across 17 extension source files | Reproduces the semantic receipt's scoped syntactic count at `b7a3b42`. |
| `PiInstance` LSP rerun | LSP available; 67 references across 21 files, including the declaration | Reproduces semantic identity/reference evidence at `types.ts:517`; it is not runtime-frequency proof. |
| Deterministic harness rerun | `yarn workspace @octocodeai/agent-testing test`: exit 0; 1 file and 12 tests passed; Vitest duration 154 ms | Reproduces the focused executable seam at `b7a3b42`; it does not establish native-host parity. |
| OpenTUI repository-seam rerun | `yarn workspace @octocodeai/pi-extension test:unit tests/opentui-shell.test.ts`: exit 1; no test files found | Confirms the route receipt's HOLD decision. The isolated Bun/Node renderer smoke cannot substitute for a repository adapter, packaging, PTY, or platform proof. |
| Documentation style | Top-level RFC: 17 files, 0 errors, 0 warnings, 155 informational findings; evidence: 3 files, 0 errors, 0 warnings, 40 informational findings | The four opening-evidence warnings were corrected without changing facts. Evidence remains a separate set, so the canonical document count stays 17. |
| RFC evaluator | Pass; score 0.929 against 0.85, all 12 required patterns present, 258 citation/evidence anchors | The residual unreplaced-placeholder finding remains the known false positive on TypeScript/JSON braces. |
| Structural validation | Exit 0; 17 top-level documents and 3 separate evidence documents; Steps 0–12; Stages 0–7; status Steps 0–12 and Stages 0–7; 92 unique feature IDs; 9 blockers; all required status sections; 8 cross-document status references | Evidence additions do not change the canonical seventeen-document map, and the execution/status ledgers remain aligned. |
| Migration gate | HOLD | Stage 0 is not complete: no single approved `before-<commit>.md`, owner receipt, complete fixture corpus, supported Pi matrix, approved OpenTUI route, or other canonical blocker resolution exists. |

### Second-wave decision integration receipt: 2026-08-27

| Check | Observed result | Interpretation |
|---|---|---|
| Dependency acceptance | `task_905a6f2169bb4aac927ee5c7`, `task_2eb4a47862614d979b207bdc`, and `task_77074dd2b24246009ef64b8b` are `DONE` and independently verified | The approval, OpenTUI-route, and Pi-version packets satisfy their bounded task contracts; packet completion grants no product approval. |
| Baseline/owner packet | Candidate SHA `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac`; 12 accountable roles; 11 approval questions; detached-checkout, ignored-evidence, privacy, redaction, normalization, and hashing protocols present | Decision preparation is complete, but no SHA or owner is approved and no canonical `before-<commit>.md` exists; B-01 and B-02 remain open. |
| OpenTUI decision packet | Recommends only a bounded Node.js 26.4.0 ESM plus `--experimental-ffi` spike; the false present-tense prototype assumption was corrected; Bun remains the reconsideration route | No manifest, package, adapter, PTY, platform, accessibility, performance, or production-route approval exists; B-08 remains open. |
| Pi version investigation | Installed coherent Pi family `0.84.2`; extension peer `^0.84.2`; upstream `0.84.3` observed as a candidate; focused extension run passed 5 files/28 tests, launcher run passed 2 files/159 tests, and both workspace typechecks exited 0 | Only the installed `0.84.2` graph has executable evidence. No packed-artifact, `0.84.3`, unsupported-version, mixed-family, or multi-platform matrix exists; B-05 remains open. |
| User-authority summary | `evidence/NEXT_DECISIONS.md` contains 15 choices with a recommended answer, safe default, and exact consequence | The summary routes decisions without duplicating packet evidence or self-approving any blocker. |
| Canonical ledger | Three decision-packet rows changed from `In progress` to `Complete`; Pre-Stage 0 and Step 0 remain unchanged; all nine blockers remain open | Evidence production is complete, while product decisions and canonical execution evidence remain pending. |
| Documentation style | Exit 0; 24 files: 17 top-level RFC documents and 7 evidence documents; 0 errors, 0 warnings, and 284 informational findings | Every current Markdown artifact passes the enforced style gate; informational guidance does not change facts or approval state. |
| RFC evaluator | Pass; `existing-code-folder-rfc` score 0.929 against 0.85, all 12 required patterns present, and 365 unique evidence anchors | The remaining unreplaced-placeholder result is the known brace/`TBD` detector: it also sees deliberate decision-packet fields and TypeScript/JSON examples, so it does not block the passing score. |
| Structural and link validation | Exit 0; 17 top-level documents, 7 evidence documents, Steps 0–12, Stages 0–7, status Steps 0–12, status Stages 0–7, 92 feature IDs, 9 blockers, all required status sections, 32 cross-document `STATUS.md` references, and 34 resolving local Markdown links | The decision summary and packet-state updates preserve the canonical document count, tracker alignment, blocker ledger, and local navigation. |
| Migration gate | HOLD | No production, manifest, configuration, or lockfile work is authorized. B-01, B-02, B-05, and B-08 remain open, as do B-03, B-04, B-06, B-07, and B-09. |

The remaining unchecked items elsewhere in this document describe implementation and release acceptance. This draft receipt validates the RFC artifact and the proposed test seam only; it does not claim that the migration has begun or that the full repository baseline passes.
