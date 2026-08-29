# Pi coding-agent removal RFC guide

> The canonical entry point for implementation is [`../README.md`](../README.md). This folder preserves the complete source RFC, planning system, decisions, and evidence archive.

This folder is the complete planning and evidence system for replacing Pi with an Octocode-owned runtime and native editor. The 2026-08-28 product decision makes `@octocodeai/pi-extension` a temporary parity oracle that is deleted after native-only conformance, observation, rollback, migration, packaging, install, and upgrade gates pass. Earlier active wording that promises permanent Pi support is superseded and tracked for reconciliation by `../10-REMAINING-WORK-PLAN.md` `DOC-005`; dated files under `evidence/` remain immutable.

The RFC is a validated planning baseline. Partial implementation exists, but the production-path audit shows that the native cutover gates are not satisfied. The current release decision remains **do not begin final Pi deletion or canary rollout**. Continue only dependency-ordered native implementation, oracle freeze, selector construction, and verification permitted by the active gates. Read [`../01-CURRENT-STATE-AUDIT.md`](../01-CURRENT-STATE-AUDIT.md), [`../08-TRACEABILITY-CHECKLIST.md`](../08-TRACEABILITY-CHECKLIST.md), and [STATUS.md](STATUS.md) before doing any work.

## Target shape

```text
octocode-agent transports and launcher
        |
        +--> OpenTUI terminal adapter
        +--> print / JSON / RPC adapters
        |
packages/octocode-agent-core
        +--> runtime and lifecycle contracts
        +--> tools, commands, sessions, prompts, and policy
        +--> settings, hooks, plugins, and event registries
        +--> host-conformance suite
        |
        +--> native Octocode host
        +--> temporary Pi oracle --> @octocodeai/pi-extension
```

Agent core must not import Pi or OpenTUI types. The final candidate requires zero live Pi references and dependency paths across source, manifests, lockfiles, built/packed artifacts, installers, update paths, and releases. Pi-specific translation stays in the temporary oracle until deletion. OpenTUI stays in the terminal adapter.

## Non-negotiable rules

1. Do not remove Pi before the Stage 6 observation gate passes.
2. Do not treat the current dirty working-tree measurements as the canonical before baseline.
3. Do not mark a stage, step, blocker, or feature complete without commit-addressed evidence.
4. Do not weaken a requirement by editing a checklist or status table. Update the owning specification first and obtain the required approval.
5. Run the same host-conformance scenarios against Pi-backed and native implementations.
6. Keep external effects out of shadow execution. Security bypasses, duplicate effects, data loss, compaction loops, and owned-child leaks have zero tolerance.
7. Preserve the frozen Pi oracle until the deletion gates pass; then remove the extension package and every live Pi product path.
8. Use Octocode search, AST, and LSP tools for code evidence. Search results are candidates; semantic identity and reachability require LSP proof.
9. Follow the repository `AGENTS.md`, package architecture documents, build order, TDD workflow, and real-path verification rules.
10. Never hand-edit generated Awareness state or claim implementation readiness from documentation validation.

## Document map and ownership

Each subject has one owning document. Other files link to it and must not redefine its contract.

| Document                                                           | Owns                                                                                               | Read or update when                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [README.md](README.md)                                             | Entry point, reading order, agent workflow, and document-routing rules                             | Entering the RFC or changing its document system                  |
| [RFC.md](RFC.md)                                                   | Decision, goals, non-goals, scope, package boundaries, alternatives, risks, and resolved questions | Changing what the project promises or excludes                    |
| [STATUS.md](STATUS.md)                                             | Current stage, step, feature progress, blockers, owners, evidence links, and change log            | Starting or finishing any tracked work                            |
| [STEPS.md](STEPS.md)                                               | Operational order for Steps 0–12, required outputs, and stop conditions                            | Selecting or closing implementation work                          |
| [MIGRATION_STAGES.md](MIGRATION_STAGES.md)                         | Stage 0–7 entry gates, exit gates, rollout, and rollback                                           | Moving between migration stages                                   |
| [PREREQUISITES.md](PREREQUISITES.md)                               | Required people, decisions, environments, baseline inputs, and blockers                            | Preparing Stage 0 or resolving a prerequisite                     |
| [IMPLEMENTATION.md](IMPLEMENTATION.md)                             | Dependency-ordered construction plan and package-level work                                        | Designing or implementing a migration slice                       |
| [SCHEMAS_AND_TYPES.md](SCHEMAS_AND_TYPES.md)                       | Canonical contracts, schemas, versions, compatibility rules, and Pi mappings                       | Adding or changing an API, interface, event, or persisted shape   |
| [READINESS_AND_FEATURE_MATRIX.md](READINESS_AND_FEATURE_MATRIX.md) | Maturity definitions, all 108 feature IDs, readiness ratings, and sourced competitor comparison    | Scoping a feature, recalculating readiness, or comparing coverage |
| [TEST_PLAN.md](TEST_PLAN.md)                                       | Mandatory unit, contract, integration, E2E, security, fault, performance, and release tests        | Writing tests, accepting a slice, or preparing release evidence   |
| [KPI.md](KPI.md)                                                   | Baselines, targets, guardrails, decision rules, traceability, and RFC validation receipts          | Measuring before/after impact or deciding proceed/hold/rollback   |
| [BEFORE_AFTER.md](BEFORE_AFTER.md)                                 | Required before/after evidence and behavior comparison                                             | Capturing a baseline or evaluating the candidate                  |
| [IMPACT.md](IMPACT.md)                                             | User, maintainer, package, security, operations, and compatibility effects                         | Reviewing consequences or accepting a difference                  |
| [OPENTUI_TERMINAL_CORE.md](OPENTUI_TERMINAL_CORE.md)               | OpenTUI boundary, lifecycle, packaging, parity, accessibility, performance, and rollback           | Working on the native interactive terminal                        |
| [SETTINGS_WEB_UI.md](SETTINGS_WEB_UI.md)                           | Unified HTML settings page, Models section, `models.json`, safe mutations, and host parity         | Changing any user-facing configuration surface                    |
| [HOOKS_AND_PLUGINS.md](HOOKS_AND_PLUGINS.md)                       | Codex hook compatibility, canonical events, trust, handlers, plugin contributions, and lifecycle   | Adding hooks, events, extensions, or plugins                      |
| [RESOURCES.md](RESOURCES.md)                                       | Primary sources, repository anchors, external references, and evidence provenance                  | Researching or adding a factual claim/source                      |

Future execution evidence belongs under `evidence/` using the templates named in `STATUS.md`; the absence of that directory before Stage 0 is expected.

## Role-based paths

### Reviewer or decision owner

Read in this order:

1. [STATUS.md](STATUS.md) for the actual state and blockers.
2. [RFC.md](RFC.md) for the decision and scope.
3. [READINESS_AND_FEATURE_MATRIX.md](READINESS_AND_FEATURE_MATRIX.md) for readiness and complete coverage.
4. [IMPACT.md](IMPACT.md) and [KPI.md](KPI.md) for consequences and decision rules.
5. [STEPS.md](STEPS.md) and [MIGRATION_STAGES.md](MIGRATION_STAGES.md) before approving execution.

### Implementation agent

Read this file and [STATUS.md](STATUS.md), then locate the next permitted item in [STEPS.md](STEPS.md). Read every document cited by that step, including [SCHEMAS_AND_TYPES.md](SCHEMAS_AND_TYPES.md) for boundary changes and the relevant specialist specification. Confirm the stage entry gate in [MIGRATION_STAGES.md](MIGRATION_STAGES.md) before editing production code.

### Test, security, or release agent

Start with [TEST_PLAN.md](TEST_PLAN.md), [KPI.md](KPI.md), and [BEFORE_AFTER.md](BEFORE_AFTER.md). Then read the owning feature specification and the active stage gate. A green aggregate score cannot override a zero-tolerance failure.

### Specialist agent

- Runtime, sessions, contracts, or adapters: `RFC.md` → `SCHEMAS_AND_TYPES.md` → `IMPLEMENTATION.md` → `TEST_PLAN.md`.
- Terminal/UI: `OPENTUI_TERMINAL_CORE.md` → `SETTINGS_WEB_UI.md` → `TEST_PLAN.md`.
- Hooks/plugins: `HOOKS_AND_PLUGINS.md` → `SCHEMAS_AND_TYPES.md` → `SETTINGS_WEB_UI.md` → `TEST_PLAN.md`.
- Research/comparison: `RESOURCES.md` → `READINESS_AND_FEATURE_MATRIX.md`; record dated primary sources and label inferences.

## Agent work protocol

### 1. Attend before acting

1. Read `AGENTS.md` and any package-specific `AGENTS.md` or `ARCHITECTURE.md` that applies.
2. Read the latest state, active step, blockers, and evidence index in `STATUS.md`.
3. Check shared Awareness state when peers, locks, messages, plan ownership, or verification debt can affect the work.
4. Confirm that the intended work is allowed by the active stage and step. If not, stop at the unmet gate.
5. Inspect the working tree and name the commit/tree state described by the evidence.

### 2. Establish evidence before design

1. Use Octocode local search or structural AST search to inventory the surface.
2. Use LSP definitions, references, callers/callees, types, and diagnostics to prove symbol identity and actual usage.
3. Read the exact source ranges that support the conclusion.
4. Record commands, tool versions, paths, counts, and unresolved ambiguity in the receipt.
5. Update `RESOURCES.md` when new evidence changes the RFC's factual basis.

### 3. Plan the smallest gated slice

1. Select one `STEPS.md` item and its feature IDs.
2. List its owning specifications, acceptance checks, expected evidence, rollback, and stop condition.
3. Write or update failing tests before production changes.
4. Keep package dependencies one-way and keep Pi/OpenTUI types behind their designated adapters.
5. Do not expand scope to adjacent dependencies or remove compatibility surfaces that the RFC retains.

### 4. Implement and verify

1. Make the smallest coherent change that satisfies the selected contracts.
2. Run the focused workspace tests, then build every changed package in dependency order.
3. Run root lint and typecheck plus the real CLI, MCP, session, transport, terminal, settings, hook, and plugin paths relevant to the slice.
4. Compare normalized Pi/native traces through the shared conformance harness.
5. Exercise the documented rollback and capture its result.
6. Stop immediately on any zero-tolerance guardrail failure.

### 5. Record and hand off

1. Create a commit-addressed receipt using the fields in `TEST_PLAN.md`.
2. Update the applicable stage, step, feature IDs, blockers, evidence index, owner, and change log in `STATUS.md` in the same change.
3. Recalculate readiness only through the rules in `READINESS_AND_FEATURE_MATRIX.md`.
4. Update `KPI.md` if a baseline, target, guardrail, decision, or RFC validation result changed.
5. State whether the next decision is proceed, hold, or rollback. Never report “complete” without linked evidence.

## Source-of-truth update matrix

| Change                                                                   | Required documents                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Goal, non-goal, scope, architectural decision, or retained compatibility | `RFC.md`, then affected traceability and status links                         |
| API, type, schema, event, or persistence contract                        | `SCHEMAS_AND_TYPES.md`, owning specialist spec, tests, feature matrix         |
| Execution order or required output                                       | `STEPS.md`, `IMPLEMENTATION.md`, and `STATUS.md`                              |
| Stage gate, rollout rule, or rollback                                    | `MIGRATION_STAGES.md`, `KPI.md`, `TEST_PLAN.md`, and `STATUS.md`              |
| Current progress, owner, blocker, or evidence                            | `STATUS.md`; do not rewrite the owning requirement                            |
| Feature addition/removal or maturity change                              | `READINESS_AND_FEATURE_MATRIX.md`, owning spec, tests, and `STATUS.md`        |
| Terminal behavior                                                        | `OPENTUI_TERMINAL_CORE.md`, `TEST_PLAN.md`, and affected impact/KPI rows      |
| Settings or model behavior                                               | `SETTINGS_WEB_UI.md`, schemas, hooks/plugins when applicable, and tests       |
| Hook, event, extension, or plugin behavior                               | `HOOKS_AND_PLUGINS.md`, schemas, settings, security tests, and feature matrix |
| New factual claim or external comparison                                 | `RESOURCES.md` plus the document using the claim                              |
| Document added, removed, renamed, or ownership changed                   | `README.md`, `RFC.md`, `RESOURCES.md`, `KPI.md`, and `STATUS.md`              |

## Status and evidence rules

Use only the states defined in `STATUS.md`: Not started, In progress, Blocked, In review, Complete, or Rolled back. A state transition requires the evidence expected by the owning step and stage.

Every execution receipt must include:

- stage and proceed/hold/rollback decision;
- commit SHA and dirty-state summary;
- environment, toolchain, OS, architecture, mode, and host;
- exact commands, exit codes, test counts, failures, skips, and duration;
- raw and normalized fixture hashes;
- AST/LSP/static evidence with versions, counts, and paths;
- first divergence and every accepted difference;
- security, duplicate-effect, data-loss, loop, leak, and performance results;
- required owner approvals.

Do not paste large raw logs into `STATUS.md`. Link the receipt and keep the status page scannable.

## Validation

For RFC-only edits:

1. verify links, paths, document ownership, step/stage/feature counts, and status references;
2. run the documentation style checker across every Markdown file;
3. run the `existing-code-folder-rfc` evaluator and classify its placeholder-brace false positive separately;
4. update the dated validation receipt in `KPI.md`;
5. add a `STATUS.md` change-log entry when the document system or current state changes.

The current style command is:

Run the `style-lint.mjs` script from the installed `octocode-documentation` skill against `DESIGN/pi-coding-agent-removal/*.md`. Do not put a developer-machine skill path in this repository.

For production changes, run the full build and command matrix in `TEST_PLAN.md`. Replace template workspace names only after the new package manifest establishes the verified name.

## Stop and escalate when

- the canonical before commit or required owner is missing;
- a proposed edit crosses an unapproved package or compatibility boundary;
- source evidence conflicts with an RFC assumption;
- a schema change lacks a versioning or migration decision;
- a hook/plugin capability lacks an approved trust policy;
- the OpenTUI runtime/package route is unresolved for a target platform;
- the same conformance scenario cannot run against both hosts;
- rollback cannot be demonstrated;
- a zero-tolerance guardrail fails;
- completing the work requires weakening an owning requirement.

When blocked, record the blocker and evidence in `STATUS.md`, leave the affected item incomplete, and hand off the smallest decision needed to resume.
