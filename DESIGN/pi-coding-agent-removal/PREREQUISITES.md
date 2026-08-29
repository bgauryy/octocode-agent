# Prerequisites: Remove `pi-coding-agent`

> Operational order: `STEPS.md`. Hook/plugin prerequisite: `HOOKS_AND_PLUGINS.md` §Current-state evidence and §Codex hook format compatibility. Native terminal prerequisite: `OPENTUI_TERMINAL_CORE.md` §Runtime and packaging gate. Settings/models prerequisite: `SETTINGS_WEB_UI.md` §Current-state evidence and §Migration and rollback.

> RFC anchors: `RFC.md` §Motivation and current state, §Reference-level explanation, and §Compatibility, rollout, and reversibility. Readiness rating: `READINESS_AND_FEATURE_MATRIX.md`. Comparison: `BEFORE_AFTER.md`. Mandatory verification: `TEST_PLAN.md`.

## Scope

This document preserves the 2026-08-26 baseline evidence and defines the reproducible release-baseline setup, blockers, and compatibility constraints. It is historical where explicitly dated and does not override current candidate status.

The baseline observed on 2026-08-26 includes unrelated uncommitted work. Capture a clean or explicitly identified commit before comparing runtime behavior. Never compare “before” from one commit with “after” from another undocumented working-tree state.

## Historical baseline evidence

| Requirement | Evidence | Confidence | Owner |
|---|---|---|---|
| Launcher SDK surface is exactly inventoried | `packages/octocode-agent/src/sdk-launcher.ts:168,241-251,324-384` | Confirmed by exact read and AST anchor | Agent runtime |
| SDK launch retains a subprocess fallback | `packages/octocode-agent/src/launcher.ts:1097-1153` | Confirmed | Agent runtime |
| Shell runtime surface is structural and small | `packages/octocode-pi-extension/src/shell/shell.ts:29-90,180,252,262` | Confirmed by AST/read | Shell/UI |
| Extension host interfaces remain broad | `packages/octocode-pi-extension/src/types.ts:235-390,517-595` | Confirmed | Harness |
| Tool registration has one host funnel | `packages/octocode-pi-extension/src/tools/octocode-tools.ts:98-125` | Confirmed by AST: one optional `registerTool` call | Harness tools |
| Central middleware has 17 registrations in the inspected 2026-08-27 tree | `packages/octocode-pi-extension/src/index.ts` | Confirmed by structural/text candidate search; Phase 0 records exact AST/runtime proof | Lifecycle |
| Command registration has 26 actual calls | 18 in `src/index.ts`; 8 across command modules | Confirmed by AST | Commands |
| Pi SDK/helper dependency-bearing files are classified | `sdk-launcher.ts`, `launcher.ts`, `serve.ts`, `types.ts`, `bash-tool.ts`, `dynamic-skills.ts`, `image-render.ts`, `export-command.ts` | Confirmed by source search/read | Runtime and harness |
| Session identity/branch consumers are inventoried | `src/tools/session-artifacts.ts`, `active-plan.ts`, `rewind-command.ts`, `compaction-state.ts`, `interaction-broker.ts`, `awareness-shared.ts`, and callers | Confirmed; includes tolerant `getLeafId` usage | Sessions |
| A host-neutral deterministic harness exists in the working tree | `packages/octocode-agent-testing/src/index.ts`; `tests/pi-flow-harness.test.ts` | Confirmed but uncommitted | Testing |
| Agent core package did not exist in the inspected tree | Local package-structure inspection on 2026-08-26 | Historical; the current candidate now contains and composes it | Agent runtime |
| Existing custom TUI/RPC decision is preserved | `.octocode/rfc/pi-custom-tui-protocol/RFC.md` and `RESOLUTION.md` | Confirmed accepted prior decision | UI/runtime |

## Measured static baseline

These values describe the inspected working tree, not a release claim:

| Check | 2026-08-26 result | Target after Phase 6 |
|---|---:|---:|
| Pi-family source text occurrences/files | 26 / 16 | 0 outside immutable historical evidence after retirement |
| `pi-coding-agent` text occurrences/files | 13 / 10 | 0 in live source, manifests, and artifacts after retirement |
| Dependency-bearing `pi-coding-agent` files | 8 | 0 after retirement |
| Direct `pi.<method>` AST calls | 40 / 5 files | 0 after retirement |
| Central `hooks.on` registrations | 17 in the inspected 2026-08-27 tree | 0 Pi-host registrations after retirement; equivalent native contract tests pass |
| Actual command registrations | 26 | Same public inventory unless an explicit product change is approved |
| Tool host registration funnels | 1 | 1 host-neutral registry boundary |
| LSP `PiInstance` references/files | 64 / 20 | 0 outside immutable historical evidence after retirement |
| LSP `PiContext` references/files | 172 / 20 | 0 outside immutable historical evidence after retirement |
| LSP `ToolDefinition` references/files | 54 / 21 | 0 duplicated canonical definitions and 0 live Pi-only types after retirement |

Raw counts are navigation metrics, not success by themselves. A renamed compatibility facade can make counts reach zero while preserving the same coupling. Structural contract and conformance checks are mandatory.

## Environment and setup

| Need | How to verify | Source |
|---|---|---|
| Supported workspace toolchain | Run the root build/test/lint/typecheck commands documented in `AGENTS.md` | `AGENTS.md` §Build and local run |
| Octocode research catalog | `npx octocode context --compact`; `npx octocode tools --json` | `AGENTS.md` §Tools |
| AST and LSP capability | Inspect schemas with `npx octocode tools localSearchCode lspGetSemantics --scheme` | `AGENTS.md` §Tools |
| Frozen Pi-oracle real path | Before deletion, build the affected packages and run the pinned extension/host comparison scenarios | `packages/octocode-agent/docs/PI_INTEGRATION.md` |
| Test host | Verify `@octocodeai/agent-testing` tests and the extension mock-host flow | `packages/octocode-agent-testing/README.md`; `packages/octocode-pi-extension/tests/mock-pi-host-flow.test.ts` |

## Baseline capture protocol

Before Phase 1, create an evidence receipt under this RFC folder, named `evidence/before-<commit>.md`, containing:

1. commit SHA and whether the tree is dirty;
2. Node, Yarn, operating-system, architecture, and installed Pi package versions;
3. exact commands and exit codes;
4. test totals and duration;
5. static AST/LSP counts from this document;
6. prompt snapshot hashes;
7. command and active-tool inventories;
8. normalized lifecycle/RPC fixture hashes;
9. composed/direct Pi listener inventory plus normalized event/decision traces;
10. dated Codex hook JSON/TOML/plugin fixture hashes and declared compatibility version;
11. plugin contribution/activation baseline inventory;
12. representative session fixture hashes with secrets and user content redacted;
13. known failures accepted by the reviewer.

Capture the corresponding `evidence/after-<commit>.md` with the same schema and compare it in `evidence/comparison-<before>-<after>.md`. Evidence files remain under this RFC directory and must not contain secrets or raw private conversations.

## Baseline verification

| Check | Command or method | Expected baseline | Evidence state |
|---|---|---|---|
| Agent package tests | `yarn workspace octocode-agent test` | Exit 0; record test count | Pending clean commit capture |
| Extension tests | `yarn workspace @octocodeai/pi-extension test` | Exit 0; record test count | Pending clean commit capture |
| Test-harness tests | `yarn workspace @octocodeai/agent-testing test` | Exit 0; all fail-closed scenarios pass | Working tree: 7/7 passed on 2026-08-26; canonical commit capture pending |
| Extension mock-host flow | `yarn workspace @octocodeai/pi-extension vitest run tests/mock-pi-host-flow.test.ts` | Exit 0; complete extension boots and runs through the structural host | Working tree: 1/1 passed on 2026-08-26; canonical commit capture pending |
| Builds | Build awareness, extension, testing package, then agent in dependency order | Exit 0 | Pending |
| Type checking | Root `yarn typecheck` | Exit 0 | Pending |
| Lint | Root `yarn lint` | Exit 0 | Pending |
| SDK interactive smoke | Start, submit a no-write prompt, abort, exit | Ordered lifecycle with no uncaught errors | Fixture needed |
| Print smoke | One deterministic mocked-provider turn | Stable stdout and exit code | Fixture needed |
| RPC smoke | Start, state, prompt, abort, commands, close | Valid JSONL and correlated responses | Existing prior fixtures require refresh |
| Session smoke | new, resume, fork, tree, name, export | No history loss; stable identity | Fixture needed |
| Compaction smoke | manual, threshold, overflow/retry | One terminal state; durable plan survives | Fixture needed |

## Blockers before implementation

| Blocker | Impact | Owner | Resolution before Step 1 |
|---|---|---|---|
| Working tree is not a canonical baseline | Comparisons could attribute unrelated changes to migration | Implementer | Select and record the exact baseline commit/dirty state. |
| `packages/octocode-agent-core/` is not created | Runtime contracts have no approved production home until Phase 1 | Runtime owner | Create the package through the approved manifest process and prove dependency direction. |
| `@octocodeai/agent-testing` is uncommitted and not yet independently baselined | Proposed conformance seam may change or fail | Testing owner | Review package boundary; run its tests and extension integration test. |
| Stable versus incidental event fields are not classified | Native protocol might freeze accidental Pi internals | Runtime owner | Capture fixtures and approve a versioned event field matrix. |
| Codex hook compatibility version and fixture corpus are not frozen | “Codex format” can drift or overclaim support | Runtime/extensions owner | Snapshot official documented shape, supported gaps, and exact JSON/TOML/plugin fixtures. |
| Plugin capability and trust policy is not approved | Extensions could become a policy bypass or arbitrary registry mutation path | Security/extensions owner | Approve capability matrix, exact-hash review, managed policy, activation transaction, and unload rules. |
| Native session storage choice is unresolved | Session phase cannot start safely | Session owner | Prototype alternatives and select with corruption/migration evidence. |
| Release compatibility window is unset | Pi adapter deletion has no objective date/usage gate | Release owner | Record window and minimum native usage threshold. |

## Contracts and migration constraints

| Contract/data/API | Compatibility constraint | Rollback or guardrail |
|---|---|---|
| Tool registry and execution | Preserve public names, schemas, policy order, updates, errors, and cancellation | Dual-host tool fixtures; fail closed on policy mismatch |
| Commands | Preserve discoverable inventory and handler semantics | Inventory diff; approved exceptions only |
| Lifecycle events | Preserve used ordering and transform/block semantics | Golden ordered traces |
| Prompt assembly | No unreviewed semantic drift | Byte snapshot plus normalized semantic diff |
| Session data | Existing Pi sessions remain readable during the window | Read-only import, backups, checksums, no in-place rewrite |
| Compaction | Preserve manual/threshold/overflow and retry behavior | Fault-injection suite; rollback on loop/loss |
| UI interactions | Preserve dialogs, notifications, status, widgets, editor, and headless degradation | Semantic UI-event assertions by mode |
| RPC/JSON | Version and validate the wire protocol; preserve prior client fixtures or supply migration adapter | Protocol contract tests and compatibility version |
| Trust and approvals | No bypass through model, UI, command, or transport path | Negative policy matrix; immediate rollback on violation |
| Awareness | Preserve semantic plan/coordination contract and session identity | Existing focused suites plus cross-host continuity scenarios |
