# Migration stages: Remove `pi-coding-agent`

> Decision: `RFC.md` §Summary. Current progress: `STATUS.md`. Operational index: `STEPS.md`. Maturity and feature IDs: `READINESS_AND_FEATURE_MATRIX.md`. Task-level implementation: `IMPLEMENTATION.md`. Contracts: `SCHEMAS_AND_TYPES.md`. Hooks/plugins: `HOOKS_AND_PLUGINS.md`. Native terminal: `OPENTUI_TERMINAL_CORE.md`. Unified settings: `SETTINGS_WEB_UI.md`. Mandatory verification: `TEST_PLAN.md` and `KPI.md`.

## Stage model

Each stage is a shippable decision gate, not a time estimate. A stage starts only when its entry criteria pass. It ends with an evidence receipt, an explicit proceed/hold/rollback decision, and no unresolved blocker for the following stage.

| Stage | Runtime state | User exposure | Main outcome |
|---|---|---|---|
| 0. Baseline | Pi only | Existing behavior | Freeze authoritative behavior and measurements |
| 1. Contracts | Pi through adapter | No intended behavior change | Product depends on Octocode contracts |
| 2. Kernel surfaces | Pi model/session with Octocode registries/lifecycle/hooks/plugins | No intended behavior change; reviewed integrations opt-in | Octocode owns host capabilities, extension events/contributions, and policy order |
| 3. Sessions | Pi runtime with native session path in tests/opt-in | Developer opt-in | Prove import, persistence, projection, and compaction |
| 4. Runtime | Pi and native implementations | Developer opt-in and pure shadow | Prove native turn/tool execution |
| 5. Transports/UI/settings | Native runtime behind every mode; OpenTUI terminal; unified settings HTML | Controlled canary | Prove OpenTUI, settings/models, print, JSON, and RPC parity |
| 6. Native default | Native default; Pi rollback adapter installed | Expanding release cohorts | Meet observation-window gates |
| 7. Dependency removal | Native runtime without Pi; separately supported Pi extension remains | General availability | Delete native-runtime `pi-coding-agent` dependency and retain tested extension compatibility |

## Stage 0: Establish the canonical before state

**Entry criteria**

- The baseline commit and dirty-state policy are selected.
- Test environments and fixture privacy rules are approved.

**Required work**

- Capture static AST/LSP/import/dependency measurements.
- Run the complete baseline command matrix from `TEST_PLAN.md`.
- Capture tool, command, prompt, lifecycle, hook/plugin, UI, RPC, session, and compaction fixtures, including a dated official Codex-format corpus.
- Classify stable and incidental event fields.
- Approve normalization rules and performance sample sizes.
- Complete the `OPENTUI_TERMINAL_CORE.md` compatibility spike for Bun or Node, native artifacts, packaging, supported platforms, startup, memory, and terminal restoration.

**Exit evidence**

- `evidence/before-<commit>.md` exists.
- Raw and normalized fixture hashes resolve from the receipt.
- All known baseline failures have owners and explicit acceptance.
- The exact OpenTUI version and supported runtime/package route have an approved receipt, or Stage 1 is held.

**Hold or rollback**

No migration code begins when the baseline cannot be reproduced.

## Stage 1: Put Pi behind Octocode contracts

**Entry criteria**

- Stage 0 passes.
- RFC Q1 assigns ownership to `packages/octocode-agent-core/`.

**Required work**

- Create `packages/octocode-agent-core/` through the approved workspace-package process.
- Define capability-focused runtime contracts.
- Implement the Pi adapter.
- Preserve the Pi-extension package as the supported Pi-host adapter and define its supported Pi-version matrix.
- Define canonical settings/model contracts and wrap the existing page/direct writers without behavior drift.
- Define canonical event, hook, trust, plugin manifest, capability, contribution, and lifecycle contracts.
- Route the existing product through the contracts.
- Generalize the deterministic test harness without weakening Pi baseline scenarios.

**Exit evidence**

- Pi-backed results match the Stage 0 corpus.
- Agent core contains the new production runtime code and does not import the launcher, Pi extension, or terminal UI packages.
- Product modules outside the adapter have no direct Pi host type dependency.
- The Pi extension passes the shared semantic suite and Pi-specific mapping suite.
- Native and Pi-extension adapters expose the same canonical settings snapshot; HTML/browser/filesystem types do not enter agent core.
- Dependency-cycle check passes.

**Rollback**

Remove the composition layer. No data format changes exist in this stage.

## Stage 2: Move registries, lifecycle, policy, and helpers

**Entry criteria**

- Stage 1 contract suite passes.
- Event ordering and error rules are versioned.

**Required work**

- Move tools and commands to host-neutral registries.
- Move composed and direct production Pi listeners to the canonical lifecycle bus with proven mappings.
- Implement the declared Codex hook discovery/merge/trust/matcher/handler compatibility surface.
- Implement plugin validation, capability grants, event activation, transactional contributions, leases, and reverse unload.
- Centralize trust, approval, plan-mode, and peer-lock policy.
- Replace Pi frontmatter, settings, shell, RPC-type, and exporter helpers.

**Exit evidence**

- Tool and command inventory snapshots match approved baselines.
- Lifecycle golden traces match or contain approved differences.
- Every used listener maps; supported Codex fixtures and native/Pi hook-plugin conformance pass.
- Plugin activation/unload is deterministic and leaves no partial registry or owned resource.
- Every security negative test passes.
- Production Pi use is isolated to runtime, session, UI, and compatibility adapters.

**Rollback**

Select the Pi adapter and restore registry/lifecycle translation. Session data stays unchanged.

## Stage 3: Prove native sessions and compaction

**Entry criteria**

- Stage 2 passes.
- Session encoding decision resolves RFC Q2.
- Migration and backup policy has a named owner.

**Required work**

- Implement native append/load/projection/recovery.
- Implement read-only Pi import into a separate destination.
- Implement new/resume/fork/tree/name/custom-entry behavior.
- Implement pure prompt assembly and compaction state machine.
- Run migration, corruption, interrupted-write, and retry fault suites.

**Exit evidence**

- The complete session corpus imports and replays without loss.
- Original Pi files retain their hashes.
- Prompt differences are zero or approved.
- Every compaction case reaches one valid terminal state.

**Rollback**

Open the original Pi session read-only through the Pi host. Preserve native data for diagnosis; never overwrite the source.

## Stage 4: Prove the native runtime

**Entry criteria**

- Stage 3 passes.
- Model/provider adapter scope resolves RFC Q5.

**Required work**

- Compose the kernel with the selected model adapter.
- Implement structured execution scopes and cancellation.
- Normalize provider deltas and retry/usage behavior.
- Run identical mocked-provider scenarios on Pi and native runtimes.
- Enable pure shadow comparison only.

**Exit evidence**

- Contract, stress, cancellation, and fault suites pass.
- Shadow receipts show zero duplicate effects.
- Performance guardrails meet the approved developer threshold.

**Rollback**

Select Pi for the affected sessions. Keep native session stores isolated.

## Stage 5: Prove every transport, UI mode, and setting

**Entry criteria**

- Stage 4 passes.
- The OpenTUI runtime/package route and native artifact matrix in `OPENTUI_TERMINAL_CORE.md` pass.

**Required work**

- Connect the native interactive adapter through `@opentui/core`; connect print, JSON, and RPC adapters without initializing OpenTUI.
- Generalize `settings.html` into the all-settings registry page and add complete Models/`models.json`, Hooks, and Plugins sections.
- Route launcher config and supported Pi-extension settings through one `SettingsService`.
- Preserve semantic dialogs, notifications, status, widgets, editor, and working state.
- Run pure UI projections, `@opentui/core/testing`, golden frames, and real PTY/platform tests.
- Validate terminal signals/restoration and malformed protocol behavior.
- Run supported-platform mode tests and manual terminal checks.

**Exit evidence**

- Every required row in the `TEST_PLAN.md` mode matrix passes.
- RPC compatibility corpus passes or an explicit version migration is approved.
- Native OpenTUI rendering passes its accessibility, performance, native-artifact, and restoration gates; native `pi-tui` references are zero.
- Every supported setting renders or has an approved machine/secret-only classification; model-source writes are atomic/revision-safe and secret scans remain clean.
- Hook/plugin discovery, review, enablement, compatibility, permissions, health, and redacted diagnostics render from canonical projections and pass native/Pi host conformance.
- No critical interaction, terminal restoration, or accessibility defect remains.

**Rollback**

Return the cohort or session to the Pi host selector.

## Stage 6: Make native the default

**Entry criteria**

- Stage 5 passes.
- Release owner resolves RFC Q4 with an observation window and expansion thresholds.
- Rollback artifact and operator procedure are tested.

**Required work**

- Enable native for an explicit canary cohort.
- Compare reliability, cancellation, compaction, import, latency, memory, and policy receipts.
- Expand cohorts only after each observation gate passes.
- Capture the candidate after receipt and before/after comparison.

**Exit evidence**

- All zero-tolerance guardrails remain at zero.
- Outcome and performance metrics meet approved thresholds.
- `BEFORE_AFTER.md` comparison has owner decisions for every difference.

**Rollback**

Restore Pi selection for new starts and preserve per-session host identity. Do not open one writable session with both hosts.

## Stage 7: Remove the native dependency and retain Pi-extension support

**Entry criteria**

- Stage 6 observation window passes.
- Release, runtime, session, security, and transport owners approve removal.

**Required work**

- Remove SDK loading, Pi package resolution, subprocess fallback, deep imports, types, helpers, and native `pi-tui` use.
- Remove `pi-coding-agent` from manifests through the approved manifest process.
- Rebuild affected packages and run the complete candidate matrix.
- Verify zero native agent/core references and classify all remaining supported-extension references with AST, LSP, source, and dependency checks.
- Remove the native runtime selector after the approved rollback window.
- Keep the Pi extension adapter, its version matrix, and its dedicated conformance tests.
- Re-point related Pi-facing RFC references without discarding their semantic requirements.

**Exit evidence**

- `evidence/after-<commit>.md` and signed comparison exist.
- The native `octocode-agent` release artifact contains no `pi-coding-agent`, `pi-tui`, or Pi fallback; the separately built Pi extension can declare its supported Pi host relationship.
- Real interactive, print, JSON, RPC, session-import, MCP, and skill paths pass.

**Rollback**

Roll back the release artifact. Do not hot-patch session data or reintroduce an untested fallback.

## Cross-stage rules

- A failed zero-tolerance guardrail forces rollback or hold.
- An ordinary mismatch requires an owner-approved fixture and impact decision before proceeding.
- A stage cannot defer its data/security prerequisite into a later stage.
- Shadow mode cannot execute model calls, writes, messages, process launches, or other external effects twice.
- Every stage records exact commands, tool versions, commit, environment, exit codes, and fixture hashes.
- The release owner can stop expansion even when automated metrics pass.
