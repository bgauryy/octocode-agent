# RFC: Remove Pi from the native agent through an Octocode-owned runtime contract

Status: Draft
Decision type: Reversible by phase; irreversible only after the final compatibility window
Authors: Octocode
Created / Updated: 2026-08-26 / 2026-08-29

## Audit Reasoning — fix and keep (2026-08-29)

- **Status:** Partially implemented. The locally runnable native implementation is complete enough to pass repository verification, native package verification, packed-install, PTY restoration, signal, and bounded-stream sensors. Agent core, the native launcher/runtime, durable sessions and compaction, official Responses and ACP adapters, session-owned MCP elicitation/tasks/provenance, contained Skill lifecycle, dynamic RPC/ACP worker projection, semantic OpenTUI widgets, hooks/plugins, discovery, and protected settings controls exist. Release acceptance remains incomplete because the clean supported-platform matrix, credentialed provider/editor/MCP runs, real Pi/native conformance, assistive-technology study, canary, observation window, and rollback rehearsal have not been observed.
- **Why kept:** This RFC remains the decision owner for the native editor cutover and the evidence gates that keep Pi out of native source, dependencies, artifacts, installers, updates, and rollback paths.
- **Evidence:** `createDefaultNativeRuntime` in `packages/octocode-agent/src/native-launcher.ts` is the shared composition root for interactive and headless modes and has direct semantic references from the launcher, replacement-session path, and tests. The same module composes core `DurableCompactionService`; `native-transports.ts` owns bounded print/JSON/RPC delivery and `native-signal-scope.ts` owns signal cleanup. The 2026-08-29 native verification reports 623 passing tests and 27 environment-dependent skips. Built help, isolated credential-free doctor output, discovery, packed install, PTY restoration and resize, signal handling, and a lossless 10,000-event stream have been exercised. The historical production-adapter baseline remains 0 matched, 1 divergent, and 13 unsupported scenarios; it is not superseded by local native verification.
- **Remaining work:** Close the external release gates in `../10-REMAINING-WORK-PLAN.md` and `../08-TRACEABILITY-CHECKLIST.md`. The CLI contract issues recorded in `evidence/native-cli-review-2026-08-29.md` are resolved with platform-only updates, discovery-aware setup and doctor output, and exact-command prompt routing. Retain `packages/octocode-pi-extension` as a separately installed Pi compatibility product with its own Pi-only dependencies, tests, version matrix, documentation, and publication path. Historical baseline files under `evidence/` remain immutable; dated research receipts may be added.

## Summary

Remove the Pi runtime from native `octocode-agent` in stages by moving every accepted native capability into the Octocode-owned agent core and native editor. Keep `@octocodeai/pi-extension` as an independently installed Pi compatibility product and executable conformance reference. The native terminal uses `@opentui/core` behind a semantic `UiPort`; agent core remains terminal-toolkit-neutral. Each phase runs the same deterministic host-conformance scenarios against the supported Pi adapter and native implementation, preserves session import and approved user-visible behavior, and meets the gates in `KPI.md` before the native release closes. The final native release contains no Pi imports, packages, subprocesses, selectors, fallbacks, installers, update paths, or transitive dependency paths.

`README.md` is the entry point and agent operating guide. Companion documents separate execution concerns: `STATUS.md` is the canonical progress ledger, `STEPS.md` is the operational index, `READINESS_AND_FEATURE_MATRIX.md` owns maturity ratings, the complete feature inventory, and external comparison, `BEFORE_AFTER.md` owns the migration comparison, `IMPACT.md` owns effects and risk, `MIGRATION_STAGES.md` owns stage gates, `SCHEMAS_AND_TYPES.md` owns contracts and Pi mappings, `HOOKS_AND_PLUGINS.md` owns Codex-compatible hooks and event-driven plugins, `OPENTUI_TERMINAL_CORE.md` owns the native terminal decision, `SETTINGS_WEB_UI.md` owns the unified settings page and Models section, and `TEST_PLAN.md` owns mandatory verification. `IMPLEMENTATION.md` remains the task-level build plan.

## Goals and non-goals

1. **Goal:** Make Octocode own the runtime, lifecycle, session, tool, command, prompt, policy, and transport contracts used by the product.
2. **Goal:** Remove every Pi import, package resolution, type import, subprocess dependency, adapter, and product path from native agent/core source, manifests, built and packed artifacts, installers, updates, and rollback paths after the release gates pass.
3. **Goal:** Preserve or intentionally improve interactive, print, JSON, RPC, session, compaction, tool, command, and security behavior with measurable evidence.
4. **Goal:** Replace large optional host objects with capability-focused, versioned interfaces.
5. **Goal:** Keep every migration phase shippable, observable, and reversible until the compatibility window closes.
6. **Goal:** Reuse one host-conformance suite for Pi-before and Octocode-after behavior instead of maintaining host-specific assertions.
7. **Goal:** Deliver the native interactive terminal on `@opentui/core` without leaking OpenTUI types into agent core or noninteractive transports.
8. **Goal:** Make `settings.html` the complete human-facing settings control center, including a Models section for default selection, effective catalog, custom providers/models, and safe `models.json` management.
9. **Goal:** Support Codex-format lifecycle hooks and trusted event-driven extensions/plugins through canonical agent-core events, schemas, contribution registries, and the unified settings page.
10. **Goal:** Expose the native runtime to editors through the Agent Client Protocol, with capability negotiation, session lifecycle, modes, permissions, progress, terminal/filesystem mediation, and generated conformance fixtures.
11. **Goal:** Govern model-visible context through hierarchical instruction provenance, semantic AST/LSP maps, deferred tool discovery, cache-friendly prompt composition, and explicit budgets.
12. **Goal:** Provide policy-controlled provider fallback and reviewable checkpoints without duplicating session, policy, or Awareness ownership.
13. **Non-goal:** Remove `@earendil-works/pi-agent-core` or `@earendil-works/pi-ai` in the first project.
14. **Non-goal:** Preserve unused Pi APIs solely because the local compatibility interfaces declare them.
15. **Non-goal:** change the Awareness storage authority or duplicate its scheduler, mailbox, lock, handoff, or memory state.
16. **Non-goal:** expose an internet-facing A2A service during Pi removal; A2A remains an optional later adapter with separate authentication and tenancy review.
17. **Non-goal:** perform a flag-day rewrite of the agent loop, providers, persistence, and protocol.
18. **Non-goal:** delete the independently published Pi extension or require workspace-wide Pi absence; Pi dependencies remain valid only inside the extension's isolated package, tests, and publication path.

## Motivation and historical baseline

At the accepted 2026-08-26 baseline, `octocode-agent` was a branded launcher around Pi and `@octocodeai/pi-extension` supplied the Octocode harness. The then-current launcher dynamically imported nine Pi SDK exports and could fall back to a Pi subprocess; those files and paths are historical evidence, not descriptions of the current native candidate. The extension's `PiInstance`, `PiContext`, and `ToolDefinition` types defined the extraction boundary.

AST/LSP checks against the 2026-08-26 working tree produced this immutable baseline snapshot:

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

These are historical working-tree observations, not current implementation claims or a release baseline. The current candidate is described by `STATUS.md`, `READINESS_AND_FEATURE_MATRIX.md`, and root designs `01`–`11`; `PREREQUISITES.md` still requires commit-addressed before/after receipts before release.

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
                (independent)
```

The product calls Octocode contracts only. During migration, the Pi adapter translates those contracts to the existing Pi SDK and extension host. The native runtime replaces one capability at a time. A phase proceeds only when both implementations pass the same conformance scenarios and the guardrails in `KPI.md`.

The first completion point removes `pi-coding-agent` while allowing two narrower native runtime dependencies:

- `pi-agent-core` can temporarily provide the model/tool loop behind `ModelLoopPort`.
- `pi-ai` can temporarily provide providers and streaming normalization behind `ModelPort`.

Removing those packages from native code requires the same evidence discipline and is part of the final native-only target. The native terminal uses `@opentui/core` through the adapter specified by `OPENTUI_TERMINAL_CORE.md`. The independent Pi extension continues to supply supported Pi behavior and cross-host reference evidence.

## Reference-level explanation

### Package boundaries

`packages/octocode-agent-core/` owns production runtime contracts, the runtime kernel, session abstractions, prompt assembly, lifecycle and registry implementations, and runtime-level adapters. The package now exists as a partially implemented candidate. It must not import `packages/octocode-agent`, `packages/octocode-pi-extension`, or a terminal UI package. The launcher imports and composes agent core. The native terminal adapter lives under `packages/octocode-agent/src/terminal/opentui/` and is the only native product boundary allowed to import `@opentui/core`. The independent Pi extension imports public agent-core contracts and translates Pi host APIs at its package boundary; agent core never imports back into the extension.

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
| Pi compatibility adapter | Translate Octocode contracts to supported Pi behavior as an independent package | Product-domain decisions or native release wiring |

The Pi extension remains independently available after native cutover. `SCHEMAS_AND_TYPES.md` owns its mapping and supported-version contract. The native launcher, core, installers, updates, and rollback artifacts must never depend on it.

### Canonical control plane and product terms

The product exposes four user-facing control-plane concepts. These names describe one semantic owner each; they are not permission to create parallel stores or host-specific behavior.

| Product term | Canonical owner | Adapter responsibility | Current live evidence and unclosed gap |
|---|---|---|---|
| **Ask** | Agent-core interaction contracts and the runtime-owned interaction request | Interactive, headless, RPC, ACP, and Pi adapters render or return a typed unsupported/cancelled result | Native `askUser` and the interaction broker exist; full mode and Pi/native conformance remains unobserved |
| **Plan** | Runtime session plan/policy projection; Awareness remains authority for shared DAG/task/work coordination | Hosts present the current plan and project shared coordination facts without duplicating authority | Native durable plan state and policy projection exist; shared-authority and cross-host receipts remain open |
| **Delegate** | Runtime `WorkerSupervisor` owns child execution/lifecycle; Awareness owns durable coordination, mailbox, handoff, and work-presence records | UI/RPC/ACP/Pi surfaces project typed spawn, message, wait, abort, and kill controls | Native worker tool and supervisor are composed; clean multi-process, platform, and cross-host evidence remains open |
| **Configure** | `SettingsRegistry` and `SettingsService` own definitions, effective values, revisions, and mutations | HTML, CLI, OpenTUI, RPC/ACP, and Pi are projections over the same service | Native sections contain one `connections` entry and no `add-server` entry (`native-settings-page.ts:12-15`); that section renders MCP server/tool controls and the MCP Tasks capability note (`native-settings-page.ts:181`). Real live-server MCP Tasks and cross-host conformance remain open |

**Connections** is the Configure information architecture for providers and external services. MCP Servers, Tools, Resources, Prompts, and **MCP Tasks** are subordinate Connections views. The MCP adapter owns protocol negotiation; runtime scopes own authorization, cancellation, and effect admission; the configured task store owns durable records. MCP Tasks is not a fifth control-plane concept and generic MCP connectivity does not imply task support.

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

### Historical Pi API inventory

The 2026-08-26 launcher used these Pi SDK exports; the removed `sdk-launcher.ts` line anchor is preserved only as historical baseline evidence:

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

The release program may use an internal `pi|shadow|native` comparison selector, but it is not a native product feature or an agent-core API. The current native launcher is correctly hard-wired to `native`. `shadow` executes only deterministic, pure comparisons; it must never duplicate model calls, writes, messages, or external effects. During a bounded comparison window, the selected host and Pi artifact identity are recorded per session, and there is never more than one writable host for a session. After the observation gate, native rollback uses a prior native artifact, and any migration selector is deleted. The independently installed Pi extension remains available to Pi users without becoming a native fallback.

The final removal is allowed only after:

1. the native default passes the defined observation window;
2. Pi session import is proven on representative fixtures;
3. native agent/core and native terminal packages do not reference Pi, and every extension-only capability has a native owner or an explicitly approved retirement;
4. the subprocess fallback is deleted;
5. release and rollback owners approve the evidence receipt; and
6. the native package, dependency tree, built and packed artifacts, installers, update paths, and rollback artifacts contain no Pi path; and
7. the Pi extension's package boundary, supported-version matrix, tests, docs, and publication path remain isolated from native release wiring.

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
| Pi adapter leaks into native release wiring | Native dependency or packed-artifact scan finds Pi | One-way package boundaries and native absence gates | Any native Pi dependency or fallback path |
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
| Add no ecosystem-derived features | Avoids scope growth | High product/integration debt | Medium-low | High | Reject: ACP, context governance, and review safety are demonstrated gaps. |
| Invent an Octocode editor protocol | Full local control | High interoperability and maintenance risk | Low | Medium | Reject: implement ACP behind a native adapter. |
| Implement ACP plus bounded context/review requirements | Fits capability ports and staged migration | Medium, isolated by adapters | High | High | Accept. |
| Add A2A and every experimental MCP extension now | Broadest protocol surface | Very high security/version risk | Medium | Low | Reject for this cutover; keep A2A optional and MCP tasks version-pinned. |

This option fits three boundaries that the repository already exposes. The shell depends on a small structural runtime surface (`packages/octocode-pi-extension/src/shell/shell.ts:29-90`). All tool registrations cross one funnel (`packages/octocode-pi-extension/src/tools/octocode-tools.ts:98-125`). The in-progress deterministic flow harness models host operations without a production Pi import (`packages/octocode-agent-testing/README.md`; `packages/octocode-agent-testing/src/index.ts`).

## Prior art and related decisions

The accepted custom TUI decision chose a Pi RPC subprocess and a locally typed wire contract rather than importing Pi types. Its original `.octocode/rfc/...` files are no longer present; immutable receipts preserve the decision. This RFC uses that behavior only as historical cross-host and transport-fixture input.

The historical Awareness surface decision owns the semantic model-facing plan/coordination contract, not the host implementation. Its original `.octocode/rfc/...` path is no longer present; current Awareness documentation and contracts are authoritative.

The 2026-08-28 coding-agent landscape audit adds eight requirements without changing the Pi-free-native decision. ACP is the accepted editor interoperability boundary; MCP durable tasks are isolated behind a pinned extension adapter and surfaced under Configure → Connections; A2A is deferred; semantic code maps use Octocode AST/LSP; model routing remains policy- and consent-bound; checkpoint restore composes with the native session/checkpoint owner. See `evidence/coding-agent-landscape-2026-08-28.md`.

## Resolved and unresolved questions

- [x] **Q1:** `packages/octocode-agent-core/` owns the production runtime contracts, kernel, session abstractions, prompt assembly, lifecycle/registry implementations, and runtime-level adapters. User decision on 2026-08-26; the current candidate contains and composes the package. Dependency-cycle validation remains an exit gate, not an ownership question.
- [ ] **Q2:** What native session encoding replaces Pi JSONL? — Resolve before Phase 3 with corruption, migration, query, and portability prototypes.
- [ ] **Q3:** Which event payload fields are stable public protocol versus internal detail? — Resolve in Phase 0 from golden Pi/RPC/flow-harness fixtures.
- [ ] **Q4:** What release window is sufficient before deleting the migration selector and ending Pi-backed rollback? — Product/release owner must set the number of releases and usage threshold before native-only promotion.
- [ ] **Q5:** Is `pi-agent-core` retained for the first native runtime or replaced immediately? — Explicitly deferred until the runtime contract and session controller pass without `pi-coding-agent`; trigger is Phase 4 entry.
- [x] **Q6:** The native interactive frontend uses `@opentui/core` directly behind `UiPort`. The accepted custom TUI protocol remains a compatibility/transport fixture unless a separate product decision ships it. Runtime and packaging compatibility must pass the `OPENTUI_TERMINAL_CORE.md` gate before Stage 5.
- [x] **Q7:** `settings.html` is the single human-facing configuration surface for the native editor. The supported Pi adapter must project the same canonical settings for comparison. It includes a registry-driven Models section and safe `models.json` management through the agent-core `SettingsService`; HTML/browser code remains adapter-owned. See `SETTINGS_WEB_UI.md`.
- [x] **Q8:** `@octocodeai/pi-extension` remains an independently installed, Pi-version-pinned compatibility product. Native `octocode-agent`, agent core, native artifacts, installers, updates, and rollback paths must remain Pi-free. User decision on 2026-08-29 supersedes the earlier deletion target; dated evidence remains unchanged.
- [x] **Q9:** ACP is the editor/IDE interoperability protocol. Native JSON/RPC remains the product's automation surface, while the ACP adapter maps session, mode, permission, progress, terminal, filesystem, and MCP capabilities into canonical ports.
- [x] **Q10:** A2A is not a Pi-retirement prerequisite. Internal multi-agent coordination remains Awareness-owned; any remote A2A gateway is a separately reviewed optional adapter.
- [ ] **Q11:** Which ACP SDK/schema and MCP tasks-extension revisions are pinned? — Resolve before their implementation work starts and record generated schema/conformance fixtures.
- [x] **Q12:** Ask, Plan, Delegate, and Configure are the canonical control-plane terms. MCP Tasks is a Connections sub-surface under Configure, not a separate authority. The ownership split is defined in §Canonical control plane and product terms; implementation completeness remains test-gated.

No recommendation in this RFC depends on unresolved Q2-Q5. `IMPLEMENTATION.md` records their closure gates and prevents dependent phases from starting early.

## Future possibilities

- Replace `pi-agent-core` with an Octocode-owned model/tool loop.
- Replace `pi-ai` with provider adapters owned in the external Octocode engine stack.
- Add richer OpenTUI views only when semantic, performance, and accessibility gates remain satisfied.
- Publish the runtime contract for non-terminal hosts.
- Add an optional authenticated A2A gateway after native cutover if a real remote-agent consumer exists.
- Replay production-redacted event traces through the conformance suite.
