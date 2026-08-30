# Execution steps

> This is the operational index. `STATUS.md` owns current progress state. `RFC.md` owns the decision; `MIGRATION_STAGES.md` owns stage entry, exit, and rollback gates. A checkbox cannot close unless its referenced documents' requirements are satisfied and linked evidence exists.

## How to use this document

Each step has a primary specification, required supporting documents, an output, and a stop condition. Implementers record commit-addressed receipts under `evidence/`, link them beside the completed checkbox, and update `STATUS.md` in the same change. Do not use this checklist to weaken a test, metric, security rule, compatibility promise, or rollback gate defined elsewhere.

## Step 0: Approve scope and owners

**References:** `RFC.md` §Goals and non-goals, §Package boundaries, and §Resolved and unresolved questions; `READINESS_AND_FEATURE_MATRIX.md` §Executive rating, §Critical blockers, and §Complete target feature inventory; `IMPACT.md`; `RESOURCES.md`.

- [x] Confirm `packages/octocode-agent-core/` ownership and one-way dependencies. Evidence: `evidence/stage-0-approval-record.md` and `evidence/implementation-run-2026-08-27-b7a3b42.md`.
- [x] Confirm native `octocode-agent` removes Pi while `@octocodeai/pi-extension` remains an independently installed Pi compatibility product. Earlier receipts preserve prior decisions; the 2026-08-29 RFC update owns the current end state.
- [x] Name runtime, session, terminal, security, release, and rollback owners. Evidence: `evidence/stage-0-approval-record.md`.
- [x] Record owners and unresolved-question triggers in the RFC review receipt. Evidence: `evidence/stage-0-approval-record.md`.

**Output:** accepted scope/owner receipt.

**Stop when:** any owner is missing or the supported Pi-extension boundary is disputed.

## Step 1: Freeze the before baseline

**References:** `PREREQUISITES.md`; `READINESS_AND_FEATURE_MATRIX.md` §Maturity scoring and §Readiness by subsystem; `BEFORE_AFTER.md` §Before evidence; `TEST_PLAN.md` §Evidence and reproducibility requirements; `KPI.md` §Baseline protocol.

- [ ] Select a clean baseline commit and record the working-tree policy.
- [ ] Re-run text, AST, LSP, dependency, lifecycle, command, tool, session, UI, mode, security, and performance inventories.
- [ ] Capture deterministic golden traces and normalized fixtures.
- [ ] Create `evidence/before-<commit>.md` with commands, versions, hashes, results, and environment.

**Output:** canonical before receipt and fixture corpus.

**Stop when:** a used Pi capability lacks a fixture or explicit invariant.

## Step 2: Prove the OpenTUI runtime route

**References:** `OPENTUI_TERMINAL_CORE.md` §Runtime and packaging gate, §Test strategy, and §Upstream evidence checked on 2026-08-27; `TEST_PLAN.md` §Environment matrix; `KPI.md` performance and platform guardrails; `IMPACT.md` UI, packaging, and operational impacts.

- [ ] Prototype `@opentui/core` and `@opentui/core/testing` without changing product behavior.
- [ ] Preserve and generalize the existing `opentui-adapter.ts`, `opentui-view-model.ts`, and four focused tests as compatibility fixtures; prove with LSP that the current proof has no production caller before relocating ownership.
- [ ] Select Bun 1.3+ or Node.js 26.4+ with experimental FFI as the supported route.
- [ ] Verify native artifacts, package installation, launcher packaging, startup, shutdown, signals, and restoration on every supported platform/architecture.
- [ ] Measure startup, first frame, frame duration, RSS, streaming, resize, and shutdown.
- [ ] Record the exact OpenTUI version and accepted runtime/packaging decision.

Current partial evidence: [the 2026-08-28 real runtime surface evaluation](evidence/real-runtime-surface-eval-2026-08-28.md) records one macOS/Node 26 experimental-FFI exact-restoration PTY pass. Step 2 remains unchecked until the clean package, performance, accessibility, and supported-platform requirements above pass.

**Output:** OpenTUI compatibility and packaging receipt.

**Stop when:** neither upstream-supported runtime route satisfies repository release requirements.

## Step 3: Create agent core and canonical contracts

**References:** `SCHEMAS_AND_TYPES.md`; `RFC.md` §Reference-level explanation; `IMPLEMENTATION.md` Phase 1; `TEST_PLAN.md` schema/type and architecture suites.

- [x] Create the planned package through the approved manifest process. Dirty-tree evidence: `evidence/implementation-run-2026-08-27-b7a3b42.md`.
- [x] Implement canonical runtime, lifecycle, tool, command, session, model, RPC, UI, process, policy, and transcript contracts. Dirty-tree evidence: `evidence/implementation-run-2026-08-27-b7a3b42.md`; production wiring and gate acceptance remain pending.
- [ ] Choose one schema/type source of truth and add deterministic drift checks.
- [x] Prove agent core imports no launcher, Pi extension, Pi package, or terminal toolkit. Focused boundary/static evidence: `evidence/implementation-run-2026-08-27-b7a3b42.md`.
- [x] Make the frozen Pi oracle import and map the canonical contracts. Adapter source and focused test evidence: `evidence/implementation-run-2026-08-27-b7a3b42.md`; the full oracle comparison gate is still failing.

**Output:** agent-core contract package and dual-host contract report.

**Stop when:** any product module outside an approved adapter needs a Pi host type.

## Step 4: Extract registries, lifecycle, policy, and helpers

**References:** `IMPLEMENTATION.md` Phase 2; `MIGRATION_STAGES.md` Stage 2; `SCHEMAS_AND_TYPES.md` runtime/tool/error contracts; `TEST_PLAN.md` contract and security suites.

- [ ] Move tool registration to `ToolRegistry` and all observed commands to `CommandRegistry`.
- [ ] Replace host hooks with the ordered `LifecycleBus`.
- [ ] Centralize trust, approval, plan, and peer-lock policy before effects.
- [ ] Replace deep Pi helpers and broad host contexts with focused capabilities.
- [ ] Run inventory, ordering, policy-negative, and adapter conformance tests.

**Output:** registry/lifecycle/policy parity receipt.

**Stop when:** an inventory differs without an approved impact decision or any security case diverges.

## Step 5: Implement native sessions, prompt assembly, and compaction

**References:** `IMPLEMENTATION.md` Phase 3; `MIGRATION_STAGES.md` Stage 3; `TEST_PLAN.md` §Session migration tests and §Fault-injection tests; `BEFORE_AFTER.md` session/compaction comparison; `KPI.md` data-integrity guardrails.

- [ ] Resolve the native storage decision with measured prototypes.
- [ ] Implement transactional append, deterministic projection, recovery, and migrations.
- [ ] Implement a read-only Pi importer that writes only to a separate native destination.
- [ ] Implement pure prompt assembly and the explicit compaction state machine.
- [ ] Prove replay, branching, restart, corruption, interrupted writes, retries, and source-file immutability.

**Output:** signed session migration and integrity receipt.

**Stop when:** any entry is lost, reordered, mutated in source, or produces nondeterministic projection.

## Step 6: Compose and prove the native runtime

**References:** `IMPLEMENTATION.md` Phase 4; `MIGRATION_STAGES.md` Stage 4; `TEST_PLAN.md` lifecycle, fault, cancellation, and performance suites; `KPI.md` reliability and duplicate-effect guardrails.

- [ ] Compose the runtime kernel and selected model/provider adapters.
- [ ] Implement structured cancellation ownership and terminal-state invariants.
- [ ] Normalize model deltas, usage, retries, model selection, and thinking control.
- [ ] Run identical deterministic scenarios against Pi and native implementations.
- [ ] Permit only pure shadow comparisons and prove no duplicated effects.

**Output:** native runtime conformance and performance receipt.

**Stop when:** traces diverge without approval, cancellation leaks, or any effect executes twice.

## Step 7: Build hooks and event-driven plugin support

**References:** `HOOKS_AND_PLUGINS.md`; `SCHEMAS_AND_TYPES.md` §Hook and plugin schemas; `IMPLEMENTATION.md` Phase 2; `TEST_PLAN.md` hook/plugin suites; `KPI.md` compatibility and security guardrails; `SETTINGS_WEB_UI.md` Hooks and Plugins sections.

- [ ] Freeze the current composed/direct Pi listener inventory with AST, LSP, and ordered runtime traces.
- [ ] Implement canonical event envelopes, stable ordered dispatch, decision aggregation, cancellation, timeouts, and audit receipts in agent core.
- [ ] Implement Codex `hooks.json`/TOML discovery, merge, matchers, exact-definition trust, command handlers, MCP handlers, outputs, and async restrictions.
- [ ] Implement versioned plugin manifests, capability grants, activation events, and transactional hook/tool/command/resource/MCP/setting/prompt/UI/model contributions.
- [ ] Adapt `OctocodeHookComposer` and direct Pi listeners to canonical events without widening event-handler privileges.
- [ ] Add Hooks and Plugins settings sections with provenance, review, permissions, health, compatibility, and redacted traces.
- [ ] Run exact Codex fixtures and native/Pi-extension conformance, security, failure, unload, and leak suites.

**Output:** hook/plugin compatibility report, event mapping, schema fixtures, settings projection, and signed security/conformance receipt.

**Stop when:** any current listener is unmapped, a compatibility definition executes without required trust, an async hook can block/rewrite, activation is partial, or any policy bypass, duplicate effect, secret leak, or owned-resource leak occurs.

## Step 8: Unify all settings in settings.html

**References:** `SETTINGS_WEB_UI.md`; `HOOKS_AND_PLUGINS.md` §Settings HTML integration; `SCHEMAS_AND_TYPES.md` settings/model/hook/plugin contracts; `IMPLEMENTATION.md` Phase 5; `TEST_PLAN.md` settings and models suites; `KPI.md` settings completeness, safety, and zero-duplicate-writer gates; `IMPACT.md` configuration and security impacts.

Progress: runtime model selection and the native page share a core-backed service,
and the page exposes protected theme/default-model mutations plus read-only extension
state. CLI writers, model sources, automation, the Pi projection, and the complete
section/action inventory remain open.

- [ ] Freeze the current eight settings sections, 11 mutation actions, security behavior, output path, LSP callers, and HTML tests.
- [ ] Implement agent-core `SettingsRegistry`, `SettingsService`, model catalog contracts, provenance, precedence, revisions, and redacted projections.
- [ ] Generalize the existing MCP-named HTML implementation into the single `settings.html` control center.
- [ ] Add Overview, Appearance, Models, Hooks, Plugins, and Diagnostics while preserving Commands, MCP, Discovery, Agent context, Skills, and Overrides.
- [ ] Implement `/settings models`, effective catalog/default-model controls, structured provider/model editing, source provenance, refresh, semantic diff, and validated advanced `models.json` editing.
- [ ] Move launcher config commands and independent Pi-extension settings projections onto the same canonical service contract.
- [ ] Prove atomic writes, conflict handling, rollback, legacy Pi source compatibility, CSP/origin/token/trust/path protections, and zero secret exposure.
- [ ] Use AST/LSP to remove duplicate direct settings writers after all consumers migrate.

**Output:** unified settings registry/page, Models/Hooks/Plugins sections, migration receipt, and settings conformance/security report.

**Stop when:** any supported setting is missing, a secret reaches generated/browser/evidence state, model configuration can be lost or overwritten, or native/Pi-extension effective values diverge without classification.

## Step 9: Build the native OpenTUI terminal

**References:** `OPENTUI_TERMINAL_CORE.md`; `SCHEMAS_AND_TYPES.md` §UI schemas and types; `IMPLEMENTATION.md` Phase 5; `MIGRATION_STAGES.md` Stage 5; `TEST_PLAN.md` §Mode matrix; `BEFORE_AFTER.md` interactive UI row.

- [x] Implement `packages/octocode-agent/src/terminal/opentui/` over semantic `UiPort` contracts using `@opentui/core` directly. Dirty-tree evidence: `evidence/implementation-run-2026-08-27-b7a3b42.md`.
- [ ] Implement renderer lifecycle, immutable presentation projection, keymap/input, focus, resize, views, interactions, and typed capability fallback.
- [x] Keep print, JSON, RPC, and headless modes free of OpenTUI initialization. Focused transport/launcher tests: `evidence/implementation-run-2026-08-27-b7a3b42.md`; the complete mode matrix remains pending.
- [ ] Run projection tests, `@opentui/core/testing` integration, golden frames, and real PTY/platform tests.
- [ ] Prove terminal restoration, accessibility decisions, protocol purity, and parity for every critical interaction.
- [ ] Remove native `pi-tui` use after OpenTUI gates pass; keep the independent Pi-extension mapping compatible with its supported host.

**Output:** OpenTUI parity, accessibility, performance, and restoration receipt.

**Stop when:** any critical interaction is missing, terminal restoration fails, or an OpenTUI type crosses into agent core.

## Step 10: Canary native and compare before/after

**References:** `MIGRATION_STAGES.md` Stage 6; `IMPLEMENTATION.md` Phase 6 rollout items; `BEFORE_AFTER.md`; `IMPACT.md`; `KPI.md` decision rule; `TEST_PLAN.md` release sign-off.

- [ ] Enable native for an explicit canary while preserving per-session host identity.
- [ ] Compare reliability, cancellation, compaction, import, policy, latency, memory, and terminal metrics.
- [ ] Review every behavioral difference and assign accept/fix/rollback with an owner.
- [ ] Create `evidence/after-<commit>.md` and `evidence/comparison-<before>-<after>.md`.

**Output:** signed before/after decision and cohort-expansion receipt.

**Stop when:** a zero-tolerance guardrail fails or an ordinary miss lacks an approved disposition.

## Step 11: Remove native Pi dependencies

**References:** `MIGRATION_STAGES.md` Stage 7; `IMPLEMENTATION.md` Phase 6 and Phase 7; `KPI.md` zero-reference metrics; `TEST_PLAN.md` static and release-artifact checks; `SCHEMAS_AND_TYPES.md` Pi-extension compatibility contract.

- [x] Remove native Pi SDK loading, resolution, subprocess fallback, RPC types, helpers, and native `pi-tui` use. Dirty-tree source/direct-manifest/built-JS evidence: `evidence/implementation-run-2026-08-27-b7a3b42.md`; transitive package and release gates remain open.
- [ ] Run text, AST, LSP, manifest, lockfile, dependency-tree, and built-artifact absence proofs.
- [ ] Classify all remaining Pi references as independent extension code, extension tests/publication wiring, or immutable historical evidence.
- [ ] Rebuild and run the complete real CLI, MCP, skill, interactive OpenTUI, print, JSON, RPC, and session-import matrix.
- [ ] Pin and test the independent Pi extension's declared version matrix.

**Output:** zero-native-Pi evidence and release candidate receipt.

**Stop when:** the native artifact contains Pi, the extension contract drifts, or any mandatory real path fails.

## Step 12: Close native Pi paths and retain extension support

**References:** `RFC.md` final-removal conditions; `IMPLEMENTATION.md` Phase 7; `MIGRATION_STAGES.md` cross-stage rules; `KPI.md` adoption/observation rule; `IMPACT.md` operational ownership.

- [ ] Complete the approved observation window and adoption threshold.
- [ ] Remove the native host selector, native Pi dependencies, fallbacks, installers, update paths, and rollback dependencies.
- [ ] Retain the independent Pi extension package, Pi-only dependencies, publication path, compatibility matrix, tests, and product documentation.
- [ ] Preserve redacted fixtures and receipts required for regression testing.
- [ ] Update ownership documentation and follow-up RFC references.
- [ ] Prove no installed, published, selectable, or documented-as-live Pi path remains in native artifacts or release wiring; classify extension-owned paths separately.

**Output:** final signed migration closure receipt.

**Stop when:** the observation window, adoption target, owner approvals, or rollback artifact is incomplete.

## Completion rule

The migration is complete only when Steps 0-12 are checked with evidence and every referenced document's gate passes. Native agent/core and native terminal artifacts must contain no Pi dependency, the OpenTUI terminal must pass the supported platform matrix, Codex-compatible hooks and event-driven plugins must pass their trust/security/lifecycle gates, and the unified `settings.html` page must cover every supported setting including Models/`models.json`, Hooks, and Plugins. The independent Pi extension must pass its compatibility matrix without becoming reachable from native artifacts, installers, updates, selectors, fallbacks, or rollback paths.
