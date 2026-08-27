# RFC: Remove `pi-coding-agent` through an Octocode-owned runtime contract

Status: Draft
Decision type: Reversible by phase; irreversible only after the final compatibility window
Authors: Octocode
Created / Updated: 2026-08-26 / 2026-08-27

## Summary

Remove `@earendil-works/pi-coding-agent` in stages by introducing an Octocode-owned runtime contract under the planned `packages/octocode-agent-core/` package and treating Pi as a temporary adapter. The native terminal is rebuilt on `@opentui/core` behind a semantic `UiPort`; agent core remains terminal-toolkit-neutral. The first scope can retain `pi-agent-core` and `pi-ai` behind independent adapters, while native `pi-tui` use ends when OpenTUI parity passes. Each phase must run the same deterministic host-conformance scenarios against the Pi-backed and Octocode-backed implementations, preserve existing session import and user-visible modes, and meet the before/after gates in `KPI.md` before the next native Pi dependency is deleted.

`README.md` is the entry point and agent operating guide. Companion documents separate execution concerns: `STATUS.md` is the canonical progress ledger, `STEPS.md` is the operational index, `READINESS_AND_FEATURE_MATRIX.md` owns maturity ratings, the complete feature inventory, and external comparison, `BEFORE_AFTER.md` owns the migration comparison, `IMPACT.md` owns effects and risk, `MIGRATION_STAGES.md` owns stage gates, `SCHEMAS_AND_TYPES.md` owns contracts and Pi mappings, `HOOKS_AND_PLUGINS.md` owns Codex-compatible hooks and event-driven plugins, `OPENTUI_TERMINAL_CORE.md` owns the native terminal decision, `SETTINGS_WEB_UI.md` owns the unified settings page and Models section, and `TEST_PLAN.md` owns mandatory verification. `IMPLEMENTATION.md` remains the task-level build plan.

## Goals and non-goals

1. **Goal:** Make Octocode own the runtime, lifecycle, session, tool, command, prompt, policy, and transport contracts used by the product.
2. **Goal:** Remove every `pi-coding-agent` import, package resolution, type import, and subprocess dependency from native `octocode-agent` and agent core. Keep Pi-specific imports isolated to the supported Pi-extension adapter.
3. **Goal:** Preserve or intentionally improve interactive, print, JSON, RPC, session, compaction, tool, command, and security behavior with measurable evidence.
4. **Goal:** Replace large optional host objects with capability-focused, versioned interfaces.
5. **Goal:** Keep every migration phase shippable, observable, and reversible until the compatibility window closes.
6. **Goal:** Reuse one host-conformance suite for Pi-before and Octocode-after behavior instead of maintaining host-specific assertions.
7. **Goal:** Deliver the native interactive terminal on `@opentui/core` without leaking OpenTUI types into agent core or noninteractive transports.
8. **Goal:** Make `settings.html` the complete human-facing settings control center, including a Models section for default selection, effective catalog, custom providers/models, and safe `models.json` management.
9. **Goal:** Support Codex-format lifecycle hooks and trusted event-driven extensions/plugins through canonical agent-core events, schemas, contribution registries, and the unified settings page.
10. **Non-goal:** Remove `@earendil-works/pi-agent-core` or `@earendil-works/pi-ai` in the first project.
11. **Non-goal:** Preserve unused Pi APIs solely because the local compatibility interfaces declare them.
12. **Non-goal:** change the Octocode tool product surface, Awareness storage model, or model-provider policy as part of host extraction.
13. **Non-goal:** perform a flag-day rewrite of the agent loop, providers, persistence, and protocol.
14. **Non-goal:** remove or silently deprecate `@octocodeai/pi-extension`; it remains a supported Pi-host adapter built on agent-core contracts.

## Motivation and current state

`octocode-agent` is a branded launcher around Pi, while `@octocodeai/pi-extension` supplies the Octocode harness. The launcher dynamically imports nine Pi SDK exports and falls back from SDK launch to a Pi subprocess (`packages/octocode-agent/src/sdk-launcher.ts:168,241-251`; `packages/octocode-agent/src/launcher.ts:1097-1153`). The extension defines local compatibility interfaces, but its central `PiInstance`, `PiContext`, and `ToolDefinition` types remain widely referenced (`packages/octocode-pi-extension/src/types.ts:323,372,517`).

Fresh AST/LSP checks against the 2026-08-26 working tree produced this current-state snapshot:

| Surface | Observed baseline | Why it matters |
|---|---:|---|
| Pi-family source references | 26 text occurrences across 16 production source files | Gives the broad package-coupling search boundary. |
| `pi-coding-agent` text references | 13 occurrences across 10 production source files | Includes comments; semantic classification is required before deletion. |
| Dependency-bearing `pi-coding-agent` files | 8 files | Covers SDK loading, package resolution, RPC types, official types, shell config, frontmatter, settings, and HTML export. |
| Direct `pi.<method>(...)` AST calls | 40 calls across 5 files | Defines the host-operation compatibility surface. |
| Central composed middleware | 17 `hooks.on(...)` registrations in the inspected 2026-08-27 tree | Event order, transforms, and cancellation must remain stable. |
| Commands | 18 central registrations plus 8 module registrations | The replacement registry must preserve 26 actual command registrations. |
| Tool registration funnels | 1 `pi.registerTool?.(...)` call | The existing single funnel is a clean adapter boundary. |
| `PiInstance` LSP references | 64 across 20 files | Measures host-registration coupling. |
| `PiContext` LSP references | 172 across 20 files | Measures execution-context coupling. |
| `ToolDefinition` LSP references | 54 across 21 files | Measures schema/execution/render coupling. |

These are working-tree observations, not release baselines. The tree already contains unrelated uncommitted changes, including an in-progress `@octocodeai/agent-testing` package. `PREREQUISITES.md` requires a commit-addressed baseline before implementation begins.

The cost of doing nothing is continued dependence on Pi's runtime composition, session format, event semantics, fallback behavior, and deep export implementation. Octocode also continues to carry a large local compatibility facade whose optional methods make actual dependencies hard to see.

## Guide-level explanation

The migration uses a strangler boundary:

```text
Octocode shell / print / JSON / RPC
                 |
            AgentRuntime
                 |
      Octocode runtime kernel
        |       |       |
   lifecycle  tools   sessions
        |       |       |
          capability ports
        |       |       |
     Pi adapter | native adapters
       (temporary)
```

The product calls Octocode contracts only. During migration, the Pi adapter translates those contracts to the existing Pi SDK and extension host. The native runtime replaces one capability at a time. A phase proceeds only when both implementations pass the same conformance scenarios and the guardrails in `KPI.md`.

The first completion point removes `pi-coding-agent` while allowing two narrower native runtime dependencies:

- `pi-agent-core` can temporarily provide the model/tool loop behind `ModelLoopPort`.
- `pi-ai` can temporarily provide providers and streaming normalization behind `ModelPort`.

Removing those packages later requires separate evidence and decisions. The native terminal instead uses `@opentui/core` through the adapter specified by `OPENTUI_TERMINAL_CORE.md`. The supported Pi extension can continue using its Pi host's UI surface.

## Reference-level explanation

### Package boundaries

`packages/octocode-agent-core/` is the required home for all new production runtime contracts, the runtime kernel, session abstractions, prompt assembly, lifecycle and registry implementations, and runtime-level adapters. The package does not exist in the inspected tree and Phase 1 creates it. It must not import `packages/octocode-agent`, `packages/octocode-pi-extension`, or a terminal UI package. The launcher imports and composes agent core. The native terminal adapter lives under `packages/octocode-agent/src/terminal/opentui/` and is the only native product boundary allowed to import `@opentui/core`. The supported Pi extension also imports agent core and translates Pi host APIs at its package boundary; agent core never imports back into the extension.

| Boundary | Responsibility | Must not know about |
|---|---|---|
| Agent core package | Own every production boundary listed later in this table | Launcher policy, CLI UX, Pi extension internals, terminal toolkit |
| Runtime contracts | Versioned event, tool, command, session, interaction, and snapshot types | Pi packages, terminal components, persistence implementation |
| Runtime kernel | Lifecycle state machine, ordered middleware, registries, prompt pipeline, execution scope | Pi SDK exports, JSONL format, UI toolkit |
| Model adapter | Provider request, streaming deltas, usage, retry classification | Session persistence, terminal rendering |
| Session store | Transactional append/load/import, branch projection, migrations | Model provider, terminal UI |
| UI adapter | Render semantic snapshots/events and answer interaction requests | Tool policy and session mutations |
| Native OpenTUI adapter | Project `UiPort` semantics through `@opentui/core`; own renderer/input/restoration | Runtime, model, session, tool-policy, or Pi internals |
| Settings service | Registry, schemas, scope, precedence, provenance, revisions, redacted values, and typed mutations | HTML, browser, terminal toolkit, Pi host, or direct filesystem UI code |
| Settings HTML adapter | Render the unified page and handle protected loopback actions through `SettingsService` | Configuration precedence, validation ownership, raw secrets, or direct unvalidated writes |
| Hook compatibility adapter | Parse Codex-format hook sources and translate canonical event input/output | Runtime policy ownership, direct registry mutation, or host-private event objects |
| Plugin manager | Validate trust, capabilities, activation events, and transactional typed contributions | Pi APIs, toolkit UI objects, unrestricted filesystem/process/network access |
| Transport adapters | Interactive, print, JSON, and RPC input/output | Runtime implementation details |
| Pi compatibility adapter | Translate Octocode contracts to existing Pi behavior during migration | Product-domain decisions |

The Pi extension remains the supported adapter for users running Octocode inside a Pi host. The temporary dependency is the native `octocode-agent` runtime's use of Pi, not the extension product. `SCHEMAS_AND_TYPES.md` owns the mapping and version contract.

The contracts should expose required capabilities, not a replacement god object:

```ts
interface AgentRuntime {
  submit(input: AgentInput): Promise<void>;
  events(signal?: AbortSignal): AsyncIterable<RuntimeEvent>;
  abort(reason?: string): Promise<void>;
  snapshot(): RuntimeSnapshot;
}

interface SessionStore {
  load(id: SessionId): Promise<SessionSnapshot>;
  append(id: SessionId, expectedRevision: number, events: SessionEvent[]): Promise<number>;
}
```

Detailed signatures are finalized in Phase 1 only after conformance fixtures freeze the observed behavior. Production contracts must use discriminated unions, exhaustive handling, explicit error types, and `AbortSignal`; they must not use `Record<string, unknown>` at an SDK boundary.

### Current Pi API inventory

The launcher uses these Pi SDK exports (`packages/octocode-agent/src/sdk-launcher.ts:241-251`):

| API | Replacement capability |
|---|---|
| `createAgentSessionRuntime` | Runtime composition root |
| `createAgentSessionFromServices` | Session controller factory |
| `createAgentSessionServices` | Dependency composition |
| `getAgentDir` | Octocode config/home resolution |
| `InteractiveMode` | Interactive transport/UI adapter |
| `runPrintMode` | Print transport adapter |
| `runRpcMode` | Versioned RPC transport adapter |
| `SessionManager` | Session store plus session controller |
| `SettingsManager` | Octocode settings repository |

The extension actively needs these host capability groups from `PiInstance` (`packages/octocode-pi-extension/src/types.ts:517-595`):

| Capability | Current operations | Target owner |
|---|---|---|
| Lifecycle | `on` | `LifecycleBus` |
| Tools | register, enumerate, activate | `ToolRegistry` |
| Commands | register, enumerate, shortcuts | `CommandRegistry` |
| Flags/settings | register/read flags | `SettingsRepository` |
| Model control | set model and thinking level | `ModelController` |
| Messages | user/custom messages and renderers | `TranscriptPort` |
| Sessions | name and durable custom entries | `SessionController` |
| Process | `exec` | `ProcessPort` |

Declared provider registration, labels, generic events, and additional event overloads are not automatically migration requirements. Phase 0 must prove a production caller or explicitly approve a new requirement before adding them.

`PiContext` is split into an immutable `ExecutionContext` and mutation services. Context contains workspace identity, session identity, mode, model snapshot, trust snapshot, context budget, and cancellation. New-session, fork, reload, compaction, navigation, model mutation, and UI interaction remain explicit services so tools cannot accidentally call command-only operations.

The session-manager extraction begins with the proven queries `getSessionId`, `getSessionFile`, and `getBranch`, while command-only session operations live in `SessionController`. Current source also uses `getLeafId` through a tolerant structural cast for rewind behavior (`packages/octocode-pi-extension/src/tools/rewind-command.ts:104-108`); Phase 0 must include it in the conformance inventory rather than hiding it behind the broad interface.

### Event contract

The runtime uses versioned discriminated events and ordered middleware. Every event defines:

- producer and allowed consumers;
- ordering relative to adjacent events;
- whether a handler can transform, block, or observe;
- error and timeout behavior;
- cancellation propagation;
- persistence and replay behavior;
- whether it is visible on RPC/JSON transports.

The initial inventory includes resource discovery; session start, shutdown, tree, and compaction; input transformation; agent and turn boundaries; tool call and execution; model/thinking selection; and provider request/response hooks. `KPI.md` requires golden ordering fixtures for each used family. `HOOKS_AND_PLUGINS.md` defines the public extension boundary, Codex event mapping, handler decisions, discovery/trust rules, and transactional contribution lifecycle. Hooks remain defense in depth; mandatory policy enforcement stays in the kernel.

### Session and persistence contract

The native session store uses an append-only event log with optimistic revisions and deterministic projections. It must support:

- stable session identity and names;
- branch/fork/tree semantics;
- atomic appends and crash recovery;
- custom durable entries that stay out of model context;
- compaction entries and retry state;
- schema-versioned migrations;
- read-only import of Pi JSONL followed by explicit native conversion;
- export and diagnostics without deep imports into another package.

The existing session listing and Pi JSONL behavior in `packages/octocode-agent/src/sessions.ts` remains a compatibility input until the migration window closes.

### Security and reliability invariants

The new kernel must centralize trust, approval, plan-mode, peer-lock, and mutation checks before tool execution. A renderer, transport, or model adapter cannot bypass policy. Every tool call receives one execution scope with an abort signal; child processes and background tasks must terminate or transfer ownership before that scope closes.

Failures must be explicit and typed. Session writes use expected revisions, middleware failures identify the handler, RPC rejects unknown protocol versions, and logs redact secrets before persistence.

### Compatibility, rollout, and reversibility

Each phase ships behind an internal host selector with three modes: `pi`, `shadow`, and `native`. `shadow` executes only deterministic/pure comparisons; it must never duplicate model calls, writes, messages, or external effects. The default remains `pi` until native acceptance gates pass. Rollback changes the selector to `pi` and does not rewrite native data.

The final removal is allowed only after:

1. the native default passes the defined observation window;
2. Pi session import is proven on representative fixtures;
3. native agent/core and native terminal packages do not reference `pi-coding-agent` or `pi-tui`; remaining Pi references are confined to the supported Pi extension;
4. the subprocess fallback is deleted;
5. release and rollback owners approve the evidence receipt.

## Drawbacks and pre-mortem

| Failure | Early signal | Prevention | Rollback trigger |
|---|---|---|---|
| Event ordering changes behavior | Golden sequence diff or flaky lifecycle tests | Central ordered bus and dual-host fixtures | Any security or session-order mismatch |
| Prompt drift changes model quality | Prompt hash/snapshot drift without approval | Pure prompt assembler and reviewed semantic diff | Unexplained prompt delta |
| Session conversion loses history | Import/replay checksum mismatch | Read-only import, fixture corpus, backup | Any unrecoverable or reordered entry |
| Compaction loops or drops state | Retry count, token overflow, missing plan state | Explicit compaction state machine and fault injection | Repeated retry or lost durable state |
| Shadow mode duplicates effects | Duplicate tool/message/write receipt | Pure comparisons only and effect classification | Any duplicate external effect |
| Native UI hides runtime failures | Missing event or stale status guardrail | Semantic UI events plus headless assertions | Critical notification/tool state absent |
| OpenTUI runtime or native package is incompatible with release targets | Packaging spike fails or native artifact is missing | Select and prove one upstream-supported Bun or Node route before terminal implementation | Any supported platform cannot install, start, render, or restore safely |
| Scope expands to all Pi packages | Phase blocked on TUI/provider rewrite | Separate adapter decisions and package-level exit gates | First-scope milestone cannot remain independent |
| Compatibility adapter becomes permanent | Native coverage stops increasing | Per-phase deletion list and sunset owner | Two releases without planned deletion progress |
| Hook/plugin compatibility creates a policy bypass | Negative hook tests or unexplained allow decision | Deny-by-default capabilities and kernel-owned authorization | Any trust, approval, plan, or lock bypass |
| Plugin activation leaves partial registrations or processes | Registry/resource leak receipt | Transactional activation and reverse-order cleanup | Any duplicate effect or owned-resource leak |

## Rationale and alternatives

| Option | Architecture fit | Migration risk | Long-term ownership | Reversibility | Decision |
|---|---|---:|---:|---:|---|
| Do nothing | Keeps current behavior | Low now | Low | High | Reject: retains runtime and deep-import coupling. |
| Fork Pi | Preserves implementation quickly | Medium | Poor; Octocode owns a large fork | Low | Reject. |
| Full rewrite in one release | Clean final state | Very high | High | Low | Reject. |
| Keep Pi only as subprocess/RPC | Strong process isolation | Medium | Medium-low | High | Use only as a transition adapter. |
| Capability contracts plus strangler adapters | Fits existing single tool funnel and structural shell boundary | Controlled by phase | High | High | Accept. |

This option fits three boundaries that the repository already exposes. The shell depends on a small structural runtime surface (`packages/octocode-pi-extension/src/shell/shell.ts:29-90`). All tool registrations cross one funnel (`packages/octocode-pi-extension/src/tools/octocode-tools.ts:98-125`). The in-progress deterministic flow harness models host operations without a production Pi import (`packages/octocode-agent-testing/README.md`; `packages/octocode-agent-testing/src/index.ts`).

## Prior art and related decisions

The accepted custom TUI RFC chose a Pi RPC subprocess and a locally typed wire contract rather than importing Pi types (`.octocode/rfc/pi-custom-tui-protocol/RFC.md`; `.octocode/rfc/pi-custom-tui-protocol/RESOLUTION.md`). This RFC preserves that client as a migration oracle and transport fixture source, then allows it to target the native runtime protocol.

The Awareness surface RFC owns the semantic model-facing plan/coordination contract, not the host implementation (`.octocode/rfc/awareness-pi-surface-consolidation/RFC.md`). This RFC must preserve that contract while replacing the Pi-facing adapter terminology.

## Resolved and unresolved questions

- [x] **Q1:** `packages/octocode-agent-core/` owns the production runtime contracts, kernel, session abstractions, prompt assembly, lifecycle/registry implementations, and runtime-level adapters. User decision on 2026-08-26; local structure inspection confirms that Phase 1 must create the package. Dependency-cycle validation remains a Phase 1 exit gate, not an ownership question.
- [ ] **Q2:** What native session encoding replaces Pi JSONL? — Resolve before Phase 3 with corruption, migration, query, and portability prototypes.
- [ ] **Q3:** Which event payload fields are stable public protocol versus internal detail? — Resolve in Phase 0 from golden Pi/RPC/flow-harness fixtures.
- [ ] **Q4:** What release window is sufficient before deleting the Pi rollback adapter? — Product/release owner must set the number of releases and usage threshold before Phase 6.
- [ ] **Q5:** Is `pi-agent-core` retained for the first native runtime or replaced immediately? — Explicitly deferred until the runtime contract and session controller pass without `pi-coding-agent`; trigger is Phase 4 entry.
- [x] **Q6:** The native interactive frontend uses `@opentui/core` directly behind `UiPort`. The accepted custom TUI protocol remains a compatibility/transport fixture unless a separate product decision ships it. Runtime and packaging compatibility must pass the `OPENTUI_TERMINAL_CORE.md` gate before Stage 5.
- [x] **Q7:** `settings.html` is the single human-facing configuration surface for native and supported Pi-extension hosts. It includes a registry-driven Models section and safe `models.json` management through the agent-core `SettingsService`; HTML/browser code remains adapter-owned. See `SETTINGS_WEB_UI.md`.

No recommendation in this RFC depends on unresolved Q2-Q5. `IMPLEMENTATION.md` records their closure gates and prevents dependent phases from starting early.

## Future possibilities

- Replace `pi-agent-core` with an Octocode-owned model/tool loop.
- Replace `pi-ai` with provider adapters owned in the external Octocode engine stack.
- Add richer OpenTUI views only when semantic, performance, and accessibility gates remain satisfied.
- Publish the runtime contract for non-terminal hosts.
- Replay production-redacted event traces through the conformance suite.
