# Before-and-after comparison: Remove `pi-coding-agent`

> Decision: `RFC.md` §Summary. Hooks/plugins: `HOOKS_AND_PLUGINS.md`. Measurement rules: `KPI.md` §Before-and-after measurement protocol. Test execution: `TEST_PLAN.md`.

## Purpose

This document defines what changes, what stays stable, and how reviewers compare the Pi-backed baseline with the Octocode-backed result. `PREREQUISITES.md` owns baseline readiness. This document owns the comparison schema.

## Comparison rules

A valid comparison uses:

- named before and after commits;
- the same supported operating system, architecture, Node version, Yarn version, provider fixture, environment variables, and test corpus;
- a clean tree or an explicitly recorded dirty-tree diff;
- raw and normalized evidence receipts under this RFC folder;
- identical normalization rules for both sides;
- an owner-approved explanation for every difference.

Never compare a release baseline with an undocumented working tree. Never remove fields from the after result merely to make a fixture match.

## Architecture comparison

| Concern | Before: Pi-backed host | After: Octocode-owned host | Required impact |
|---|---|---|---|
| Production ownership | Runtime behavior spans launcher and Pi extension integration | `packages/octocode-agent-core/` owns contracts, kernel, sessions, prompt, lifecycle/registries, and runtime adapters | One package owns the runtime boundary |
| Pi extension | Owns Octocode harness behavior directly against Pi-shaped contracts | Supported adapter imports agent-core contracts and owns only Pi translation/presentation | Pi users retain a supported extension without reverse dependency |
| Composition | `sdk-launcher.ts` dynamically imports nine Pi SDK exports | One Octocode composition root injects capability ports | Product modules no longer load `pi-coding-agent` |
| Runtime | Pi creates services, sessions, and runtime | `AgentRuntime` and runtime kernel own lifecycle and execution | Equivalent observable behavior |
| Host API | Broad `PiInstance` with optional methods | Required capability interfaces such as `ToolRegistry` and `LifecycleBus` | Compile-time dependency reduction |
| Execution context | Broad `PiContext` combines immutable state and mutations | Immutable `ExecutionContext` plus explicit mutation services | Tools cannot access command-only session operations |
| Tool contract | Pi-compatible schema, execution, policy preparation, and rendering in one definition | Host-neutral schema/executor with separate policy and presentation metadata | Preserve public names and schemas |
| Commands | Commands register directly with the Pi host | `CommandRegistry` owns registration and discovery | Preserve approved public inventory |
| Lifecycle | Pi hooks plus Octocode hook composition | Versioned ordered lifecycle bus | Preserve transform, block, error, and order semantics |
| Hooks | Pi-host listeners and local composition | Codex-compatible loader over canonical agent-core events with Pi adapter | Preserve current behavior and enable portable reviewed hooks |
| Plugins/extensions | Static host activation and direct registration | Trusted event activation plus capability-scoped transactional contributions | Deterministic registration, unload, compatibility, and audit |
| Sessions | Pi `SessionManager` and Pi JSONL | Versioned Octocode session store plus read-only Pi importer | No in-place rewrite or history loss |
| Compaction | Pi session compaction callbacks and retry behavior | Explicit Octocode compaction state machine | Preserve all reasons and one terminal state |
| Prompt | Pi session/runtime assembles prompt inputs | Pure Octocode prompt assembler | No unapproved semantic drift |
| Interactive UI | Octocode shell over Pi runtime and Pi TUI components | Octocode runtime with semantic `UiPort` plus native `@opentui/core` adapter | Preserve critical semantics, improve ownership, restore terminal on every exit path, and keep OpenTUI types adapter-private |
| Settings UI | Pi-extension `settings.html` owns eight sections while launcher settings remain separate | One registry-driven `settings.html` for native and supported Pi-extension hosts | Every supported human-facing setting appears or has an approved classification |
| Models configuration | Default provider/model in Pi `settings.json`; `models.json` remains outside the page | Models section manages effective catalog, default selection, custom providers/models, and canonical/legacy sources | Provenance, precedence, schema, revision, atomicity, recovery, and zero-secret gates pass |
| Print/JSON/RPC | Pi mode runners and Pi RPC types | Octocode transport adapters from shared contracts | Versioned wire compatibility |
| Settings/helpers | Pi settings, shell, frontmatter, and export helpers | Octocode-owned repositories/helpers | Remove helper and deep-import coupling |
| Fallback | SDK launch can fall back to a Pi subprocess | Release artifact rollback, not a hidden runtime fallback | Failures become explicit and observable |

## Static dependency comparison

| Measurement | Observed working-tree before | Canonical before | Required after |
|---|---:|---:|---:|
| Pi-family source text occurrences/files | 26 / 16 | Capture in Phase 0 | Tracked only for separately retained adapters |
| `pi-coding-agent` text occurrences/files | 13 / 10 | Capture in Phase 0 | 0 in native agent/core; supported extension references classified |
| Dependency-bearing `pi-coding-agent` files | 8 | Capture in Phase 0 | 0 in native agent/core; extension adapter files allowed |
| Direct `pi.<method>` AST calls | 40 / 5 files | Capture in Phase 0 | 0 outside supported Pi-extension adapter |
| Central `hooks.on` registrations | 17 in the inspected 2026-08-27 tree | Capture in Phase 0 | 0 outside supported Pi-extension adapter; equivalent lifecycle contracts pass |
| `PiInstance` LSP references/files | 64 / 20 | Capture in Phase 0 | 0 outside supported Pi-extension adapter |
| `PiContext` LSP references/files | 172 / 20 | Capture in Phase 0 | 0 outside supported Pi-extension adapter |
| Pi-compatible `ToolDefinition` LSP references/files | 54 / 21 | Capture in Phase 0 | 0 duplicated canonical definitions; Pi-only adapter types allowed |
| Pi subprocess launch paths | Present | Capture exact callers | 0 |
| Deep Pi imports | HTML exporter path present | Capture exact imports | 0 |

The observed values describe the 2026-08-26 dirty tree and provide navigation evidence only. Phase 0 must replace the canonical-before column with a commit-addressed receipt.

## Product behavior comparison

| Flow | Before evidence | After evidence | Pass rule |
|---|---|---|---|
| Start and stop | Ordered host lifecycle trace | Ordered runtime trace | Same required order and exactly one terminal stop |
| Submit prompt | Pi session prompt call and emitted deltas | `AgentRuntime.submit` and runtime events | Same accepted input, queue behavior, and visible deltas |
| Steer/follow-up | Pi streaming delivery behavior | Runtime input policy | Same ordering and rejection behavior |
| Cancel | Pi session abort plus process cleanup | Runtime execution-scope cancellation | One terminal event and zero owned children |
| Tool success | Gate, start, updates, end, result | Same normalized trace | Same policy decision, updates, result, and durable effects |
| Tool failure | Pi error result/event | Typed runtime error/event | Same user-visible class and no hidden side effect |
| Command | Pi registry and command context | Octocode registry and command services | Same approved commands and session permissions |
| Model/thinking | Pi setters/events | Model controller | Same supported transitions and errors |
| Session new/resume | Pi session manager | Session controller/store | Same identity and transcript projection |
| Fork/tree/rewind | Pi branch and leaf operations | Versioned branch projection | Same ancestry and selected leaf |
| Compaction | Pi callbacks and retry | Compaction state machine | Same reason classification and preserved durable state |
| Export | Pi HTML exporter plus branding | Octocode exporter | Equivalent content and no deep Pi import |
| Interactive UI | Shell and Pi TUI events | Semantic UI events projected through OpenTUI | Same critical interaction/status behavior plus OpenTUI renderer, PTY, accessibility, performance, and restoration gates |
| Settings/models | Existing page snapshot, actions, direct writers, default model, and model sources | Unified page/service snapshot and mutation receipts | Same effective behavior or approved migration; zero missing settings, lost updates, corruption, or secret exposure |
| Hooks/plugins | Pi listener traces plus Codex/manifest fixtures | Canonical decisions, contributions, trust, health, and cleanup receipts | Supported compatibility fixtures pass; zero unmapped listeners, bypasses, partial activation, or leaks |
| Print | Pi print runner | Print adapter | Same normalized output and exit code |
| RPC/JSON | Pi protocol | Versioned Octocode protocol or compatibility adapter | Contract corpus remains valid |

## Session-data comparison

| Property | Before | After | Verification |
|---|---|---|---|
| Source format | Pi JSONL | Native versioned store | Format/version inspection |
| Migration | Not applicable | Read Pi source and write a separate native destination | Original-file hash stays unchanged |
| Transcript | Pi branch projection | Deterministic native projection | Normalized message sequence and content hash |
| Custom entries | Pi entries outside model context | Native durable events outside model context | Context inclusion/exclusion assertions |
| Branches | Pi parent/leaf graph | Native branch projection | Node, parent, label, and leaf comparison |
| Compaction | Pi compaction entry | Native compaction event/projection | Pre/post context and continuation checks |
| Unknown entries | Pi-defined behavior | Preserve as opaque import records or reject explicitly | Forward-compatibility fixture |
| Corruption | Pi reader behavior | Explicit typed recovery/failure | Truncated and malformed fixture suite |

## Operator and maintainer comparison

| Area | Before | After | Success signal |
|---|---|---|---|
| Failure diagnosis | SDK failure can fall back to a subprocess | One selected host and typed composition failure | Error identifies failed capability and phase |
| Rollback | Implicit launcher fallback | Explicit host selector, then release-artifact rollback | Every rollback leaves source session data unchanged |
| Observability | Pi and extension events/logs | Versioned receipts with redaction | One trace correlates input, model turn, tool, and session revision |
| Testing | Pi-specific mocks and integration tests | Shared host-conformance suite plus adapter suites | Same scenario runs against both hosts |
| Change surface | Broad optional host types | Required capability interfaces | LSP shows bounded consumers per capability |
| Source ownership | Runtime logic is coupled to launcher/extension host surfaces | New runtime production code lives under `packages/octocode-agent-core/` | Package-boundary checks reject misplaced runtime code |
| Upgrade ownership | Upstream Pi determines runtime behavior | Octocode reviews contract and kernel changes | Runtime changes include contract/fixture review |
| Hook/plugin operation | Pi-specific wiring and code inspection | `#hooks`/`#plugins` settings, exact-hash review, compatibility and redacted traces | Users can explain what loaded, ran, changed, failed, and unloaded |

## Hook and plugin comparison

| Property | Before capture | Required after | Pass rule |
|---|---|---|---|
| Event coverage | Ordered traces for every production-used composed/direct Pi listener | Canonical mapping plus Codex compatibility classification | Zero unmapped used listeners |
| Hook format | Host-local code/config behavior | Declared Codex JSON/TOML fixtures | 100% of supported fixtures pass |
| Trust | Current host/project trust evidence | Workspace, exact-definition hash, managed policy, and separate enablement | Zero untrusted or changed-definition executions |
| Decisions | Pi middleware outputs | Canonical deny/allow/no-decision, rewrite, context, and stop receipts | Same approved semantic result and order |
| Plugin registration | Static activation inventory | Transactional typed contribution inventory | No partial registration or silent duplicate override |
| Cleanup | Session shutdown traces | Reverse unload plus process/temp/lease cleanup | Zero owned-resource leaks |

## Evidence receipt comparison

The comparison receipt must include this table:

| Item | Before receipt | After receipt | Difference | Decision |
|---|---|---|---|---|
| Environment | Recorded values | Recorded values | Exact or explained | Pass/fail |
| Static dependencies | Counts and paths | Counts and paths | Deletion trend | Pass/fail |
| Contract tests | Suite/test totals | Suite/test totals | Missing/new failures | Pass/fail |
| Golden traces | Fixture hashes | Fixture hashes | First semantic divergence | Pass/fail |
| Sessions | Import/replay hashes | Native hashes | Loss/reordering | Pass/fail |
| Security | Negative-test results | Negative-test results | Any bypass | Pass/fail |
| Performance | p50/p95 and sample count | p50/p95 and sample count | Absolute and relative delta | Pass/fail |
| Reliability | Success/error/cancel totals | Candidate totals | Confidence interval | Pass/fail |
| Approved differences | Baseline behavior | Candidate behavior | User impact and rationale | Owner approval |

The release owner signs the comparison only when all zero-tolerance guardrails pass and every nonzero difference has an owner and decision.
