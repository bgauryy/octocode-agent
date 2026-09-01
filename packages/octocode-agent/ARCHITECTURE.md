# Native agent architecture

`octocode-agent` is the native host adapter and composition package. It depends
inward on `@octocodeai/agent-core`; core never imports this package.

## Ownership

- `native-launcher.ts` is the native composition root for sessions, settings,
  models, tools, policy, Awareness, extensions, and transports.
  It parses `--permissions strict|default|allow-all` and passes the selected mode
  into core; it does not decide approval semantics. Registered tools publish a
  static capability ceiling, and any input-sensitive resolver may only narrow that
  ceiling. Custom plugin tools therefore work by declared capability rather than a
  hard-coded tool-name allowlist.
  `native-runtime-session-projector.ts` owns lifecycle-to-session durability,
  `presentation/contracts.ts` owns the renderer-neutral interactive presentation
  port and semantic event contract, `native-runtime-presentation.ts` owns
  runtime-to-presentation translation, and
  `native-interactive-controller.ts` owns interactive input, signals, slash
  commands, presentation, and ordered teardown.
- `native-provider-registry.ts` is the model composition boundary. It composes the
  canonical, persisted-settings, and environment model sources into the core
  `ModelCatalog`; runtime selection is validated against that effective catalog.
  `native-model.ts` maps core model requests onto the Vercel AI SDK and its
  official OpenAI, Anthropic, and OpenAI-compatible providers; those SDKs own
  provider wire formats. External credentialed provider conformance remains a
  release gate. Pi's provider runtime is a comparison oracle, not a native
  dependency. Protocols with required continuation metadata need explicit
  adapter support and durable core contracts; discovery alone never implies
  executable support.
- `native-mcp.ts` uses the official MCP client with session-owned connection
  reuse, negotiated catalog invalidation, closed-connection eviction, retry on
  the next safe request, progress, and shared
  shutdown. Its strict action schemas distinguish read operations from calls and
  task cancellation. Tasks use generic SDK `request` with the official
  `tasks/get`, `tasks/list`, `tasks/result`, and `tasks/cancel` envelopes and
  matching exported result schemas; the adapter does not depend on optional
  convenience methods. Task IDs and list cursors remain opaque, and list/cancel
  require their separately negotiated capabilities. `parallel-call` preflights
  every server, tool, and input schema before invoking any server, accepts one
  through eight ordered calls,
  admits at most four globally, and also enforces each server's configured limit.
  Session-owned elicitation, provenance, and durable Tasks are implemented.
  `discover` exposes a cache-aware negotiated tool catalog; `refresh` forces a
  new bounded `tools/list` traversal. Catalog state is `not-loaded`, `ready`,
  `stale`, or `empty`; the Settings control center receives the bounded live
  snapshot. A negotiated `tools/list_changed` notification moves it to `stale`,
  emits a semantic `mcp.catalog-invalidated` notification without tool data,
  and the next discovery reports an `updated` phase. Reconnection never replays
  a call or task cancellation that might already have committed remotely.
- `native-tools.ts` exposes the external Octocode catalog through one compact
  `octocode` facade. `native-file-tool.ts`, `native-bash-tool.ts`,
  `native-web-tool.ts`, and `native-ffmpeg-tool.ts` own the default local
  mutation, process, public-web, and media-process base tools. Each tool
  publishes its own schema, effects, approval, trust, and concurrency metadata
  instead of inheriting catalog-wide authority.
  Inner `web` and `octocode` batches use one shared, abort-aware pool per tool
  composition so nested batching cannot multiply the four-operation ceiling.
  The compact `octocode` facade preflights every inner schema before any executor
  starts.
  `native-file-tool.ts` also owns file schemas, edit semantics, and the injected
  `NativeFileSystemPort`. Production injects `native-rust-file-system.ts`; the
  Node implementation is explicit test infrastructure and never a silent
  production fallback.
  File mutations may explicitly opt into the Rust two-phase checkpoint port.
  `native-checkpoints.ts` strictly decodes transition/recovery receipts and owns
  the standalone rewind tool definition. Rewind is admitted as a new destructive
  effect with its own attempt ID and digest fence; it never rewrites the original
  effect. `native-checkpoint-events.ts` removes host paths and diagnostic detail,
  then the launcher sends each receipt through core's checkpoint-only ingress so
  session durability, RPC visibility, subscribers, and presentation share one
  ordered event flow. The file and rewind tools share that single sink.
- `native-command-catalog.ts` is the authority for slash-command routing, help,
  and composer completion. `native-settings-page.ts` owns the protected
  loopback browser adapter. `native-settings-service.ts` is the persistence
  bridge to the canonical core registry/service; the launcher shares one
  instance with runtime model selection and the page. `config set` uses typed
  mutations, while `models --set` commits provider and model as one optimistic,
  atomic transaction that preserves unrelated stored keys.
- `native-extensions.ts` composes hook/plugin catalogs, review, capability gates,
  transactional activation, contribution ownership, and unload leases.
  `native-extension-adapters.ts` discovers contained user/workspace Codex hooks
  and plugins; `native-hook-dispatcher.ts` projects reviewed command hooks onto
  runtime-owned lifecycle buses. Persisted extension policy is fail-closed:
  missing review/grant state grants nothing; exact reviewed hashes and complete
  explicit capability grants are required before transactional activation.
- `native-workers.ts` owns child-process control,
  `native-worker-recovery.ts` reconciles orphaned durable ledger entries, and
  `native-worker-projection.ts` exposes strict worker commands through the same
  bounded JSONL RPC writer as ordinary runtime RPC. Mutating projections are
  bound to the active session/prompt/capability ceiling and require trusted,
  on-request process approval. Recovery persists and revalidates OS process
  identity before signalling an owned orphan.
  Restart reconciliation also atomically abandons session-scoped stranded worker
  communication leases. It never replays input whose delivery state is unknown.
  Core additionally rejects spawn packets that delegate the `worker` tool and
  rejects Octocode capability subsets unless the compact `octocode` facade is
  present. The native depth marker remains a process-boundary defense; every child
  is depth one and cannot create another child.
- `native-signal-scope.ts` owns first-signal semantics and bounded cleanup for
  print, JSON, RPC, and ACP transports. `native-transports.ts` and
  `native-acp.ts` translate that lifecycle without owning runtime state.
- Durable compaction is composed in `native-launcher.ts` through the core
  `DurableCompactionService`. Attempt state and the validated projection are
  committed to the session store before live context changes. Resume rebuilds
  summary-plus-retained context from the committed record.
- `native-context-artifacts.ts` converts bounded plan, skill, memory-lead, tool,
  and committed-summary sources into strict core context manifests. The stable
  system prompt remains message zero; inspectable data-only artifact projections
  follow it and are reassembled after compaction. Projection receipts make
  inclusion, omission, budgets, and the stable-prefix digest observable without
  leaking artifact IDs or bodies. Core emits `context.artifacts-projected` once
  after initial context becomes usable and after a committed compaction projection
  replaces live context.
- `native-prompt.ts` composes the stable product and Awareness policy with
  hierarchical repository instructions. `native-communications.ts` separately
  consumes live, session-scoped Awareness events and projects validated context
  into the runtime. The static prompt is not the coordination data plane.
- `native-automation-scheduler.ts` owns schedule expansion, polling,
  heartbeats, retries, misfire behavior, and semantic execution.
  `native-rust-automations.ts` adapts the scheduler to atomic Rust definition,
  claim, lease, fencing, and terminal-settlement operations. Rust never executes
  arbitrary action payloads.
- `native-rust-core.ts` is the strict JSONL process bridge.
  `native-rust-data-ports.ts` adapts the Rust actor to the canonical core
  `SessionStore`, transactional session discovery/navigation, and
  `EffectLedgerPort`, and
  `native-rust-worker-messages.ts` adapts its leased communication queue to
  parent-to-worker input. `native-rust-work-dag.ts` strictly adapts the actor's
  immutable dependency-work graph, ready claims, lease heartbeats, and fenced
  settlements for TypeScript-owned schedulers. `native-worker-dag-scheduler.ts`
  binds those durable item IDs to immutable packets prepared from the active
  native plan, dispatches them through `WorkerController`, heartbeats live
  claims, and reconciles fenced terminal states back to the plan. It runs only
  inside one admitted `worker.schedule` tool call; it is not a background timer.
  Rust stores topology, ownership, and bounded outcomes, never prompts or other
  executable payloads. The worker tool's ordinary schema, trust, approval,
  capability, effect, and process boundaries therefore remain authoritative.
  Plans with host-owned `checkCommand` verification are rejected instead of
  letting a child bypass the authoritative verifier.
  Worker input uses
  validated Vercel AI SDK `UIMessage` values as the semantic envelope. Octocode
  RPC remains the process-control,
  cancellation, event-ordering, and response-correlation protocol. A Rust queue
  lease is acknowledged only after the matching child RPC response; failures
  release it, and expired leases can be reclaimed after restart. The launcher
  resolves the Rust binary packaged beside the built CLI. Session
  compare-and-append, project-scoped session indexing/navigation, effect
  admission/settlement, and worker message delivery use the Rust SQLite actor;
  automation definitions, run claims, heartbeats, and settlements use the same
  actor. `OCTOCODE_AGENT_RUST_CORE_BIN` and `OCTOCODE_AGENT_RUST_CORE_DB` accept
  absolute paths as explicit development overrides. Provider, MCP, policy,
  projection, settings-service, Awareness semantics, UI, and transport ownership remain in
  their TypeScript ports. `--no-session` always remains in-memory.
- `native-pi-session-import.ts` owns the read-only compatibility decoder for the
  pinned Pi v3 JSONL session format. It validates a frozen source snapshot,
  reconstructs Pi's active branch and compaction-aware model replay, omits hidden
  thinking, and rejects content that native session events cannot preserve. The
  source is hashed before and after decoding and is never mutated; an injected
  `SessionStore` receives the complete import in one revision-zero append, so
  production durability remains Rust-owned. The same module exposes the pure,
  release-owned migration cohort selector. Rollback and invalid policies fail
  closed, and runtime settings or environment variables cannot silently enroll a
  user into migration.
- `native-rust-file-system.ts` supervises and correlates the separately packaged
  `octocode-agent-fs` process. It maps bounded reads, hashes, atomic replacement,
  deletion, cancellation, and committed-aware errors onto `NativeFileSystemPort`.
  The service is not part of the SQLite actor, so filesystem latency cannot block
  session or lease transactions. Unix uses descriptor-relative operations and
  Windows uses a capability-rooted handle resolver; other targets fail closed
  rather than falling back to lexical path checks.
  Its Unix checkpoint adapter prepares content-addressed transitions, applies
  them in a second correlated request, and exposes read-only restart recovery.
  This keeps checkpoint bytes out of session SQLite and makes a process fault
  between prepare and apply deterministically observable as `partial`.
- `terminal/opentui/presentation.ts` implements the native presentation contract,
  owns the presentation reducer, and adapts renderer-neutral plan events into
  OpenTUI widget state. `create-terminal.ts` is the terminal composition root and
  creates one renderer-owned vanilla Zustand store. The store keeps immutable
  `presentation` and serializable `view` domains plus stable named actions;
  selectors derive interaction, active-turn, key, and layout facts.
  `presentation/design/` owns the canonical dark/light palettes, layout
  thresholds, shared content, and semantic tones consumed by both OpenTUI and
  the protected browser control center. `terminal/opentui/state/view-store.ts`
  owns the combined terminal store. Renderables, widget instances, controllers,
  abort signals, and runtime/session truth never enter it. The fixed shell stays
  in `renderer.ts`; semantic widget components stay under `widgets/`;
  `opentui-adapter.ts` is the dynamic toolkit-materialization boundary; and
  `layout-policy.ts` owns shared breakpoint and viewport decisions. Render
  regions carry explicit tones, so adapters never infer severity from
  user-visible prose. See `docs/TERMINAL_DESIGN_SYSTEM.md`.
  `presentation/contracts.ts` strictly decodes interaction requests before they
  enter reducer state: text, option count, stable workflow IDs, step bounds,
  and optional instructions are copied and bounded. The semantic select ceiling
  is 50 options and workflow ceiling is 20 questions in both tool and renderer
  contracts, so accepted data cannot fail later only because a concrete widget
  has a narrower limit. Alternate output includes the same question progress,
  instructions, and available answer/discuss/cancel actions as the visual path.
- `native-interactions.ts` owns the `askUser` workflow. A request may remain one
  primitive question or contain one through twenty stable-ID questions. The
  workflow advances serially, retains answers in question order, and stops with
  a typed partial ledger on discuss, cancellation, timeout, or unsupported
  presentation. Each renderer receives only the active question plus immutable
  workflow progress, title, instructions, and whether Discuss is allowed.
  Renderers return answer, discuss, or cancellation intents; they never own the
  question queue or mutate the answer ledger. OpenTUI renders the active step
  through its existing semantic widgets and exposes Discuss as Ctrl-D (and
  `/discuss` through line-oriented input).
- Canonical worker lifecycle events project into renderer-neutral
  `worker-changed` updates. OpenTUI owns the presentation clock and dedicated
  `worker.progress` cards; it never receives worker capabilities, prompts,
  terminal handback payloads, or process details. The persistent footer derives
  a bounded operational summary so approvals, failures, active tools/workers,
  plan progress, and compaction remain visible when the Activity rail collapses.
- `terminal/opentui/` is the only OpenTUI toolkit boundary. Its renderer and
  adapter own lifecycle/composition. Toolkit-facing helpers for keymaps and rich
  content remain contained in the same subtree. The native composition root can
  select the default OpenTUI adapter, but other native modules depend only on the
  presentation port. OpenTUI values never enter core, sessions, or transports.
- `native-user-input.ts` verifies PNG, JPEG, GIF, and WebP signatures, resolves
  terminal-dropped paths through `NativeFileSystemPort.readBinary`, and constructs
  canonical `RuntimeUserInputV1` parts. OpenTUI keeps payload bytes outside its
  draft and emits only the typed renderer-neutral input contract; safe markers
  expose a basename, media type, and size, never base64 or an absolute path.
- `ComposerPasteStore` retains large sanitized multiline pastes outside the visual
  draft. OpenTUI displays a digest marker and expands the exact retained text at
  submission; unknown or repeated markers remain literal, and retained-cap overflow
  stays inline instead of truncating user data.
- `@octocodeai/octocode-shared` owns shared paths, protocols, prompt fragments,
  entities, and discovery helpers. Native code imports its published subpaths
  instead of recreating policy or importing the aggregate package root.

## Prompt, configuration, and capability data flow

The system prompt is a stable authority prefix, not a dump of live state.
Configuration and discovered capabilities enter through typed data projections:

```text
environment + registered settings + model sources
  -> native settings/model resolution
  -> selected provider, model, trust, permissions, and capability ceiling

shared product policy + Awareness policy
  -> native-prompt product component
runtime cwd
  -> runtime-context component
trusted hierarchical AGENTS.md or CLAUDE.md
  -> repository-instructions component
  -> hashed NativePromptRecord
  -> message zero

plan + skill manifest + tool summary + memory leads + committed compaction summary
  -> native-context-artifacts
  -> bounded ContextProjectionV1 receipts and data-only messages
  -> model context after the stable system message
```

Skill discovery reads strict `SKILL.md` inventories with source precedence,
trust, enablement, revision, and parse diagnostics. The model initially receives
only the bounded skill manifest. `skill list` returns public metadata, and
`skill load` returns the selected instructions and support-file inventory. Skill
mutation uses the ordinary schema, policy, approval, and effect pipeline.

MCP has two deliberately different discovery layers:

```text
configuration discovery (no server activation)
  canonical Octocode files + normalized foreign host files
  -> provenance + validity + disabled-by-default imported definitions
  -> persisted workspace/global enablement overrides

protocol discovery (explicit network/process activation)
  MCPTool discover | refresh
  -> acquire/reuse official SDK client
  -> initialize and negotiated capabilities
  -> bounded paginated tools/list
  -> cache state + catalog result + tool.updated progress
  -> renderer-neutral tool activity
```

The settings page combines configuration sources and persisted enablement with a
bounded live runtime snapshot. It distinguishes disconnected, not-loaded, ready,
stale, and genuinely empty catalogs, shows the last refresh and catalog count, and
lists at most 100 sorted tool names. Catalog refreshes don't mutate the Settings
revision because negotiated server state isn't configuration.

## Worker communication data flow

Workers are root-owned processes and children are leaves:

```text
root worker tool request
  -> core depth/capability validation and four-worker admission
  -> native worker supervisor + identity-bound bootstrap
  -> AI SDK UIMessage semantic envelope
  -> Rust stage + lease + fencing record
  -> versioned Octocode JSONL RPC request over child stdin
  -> ordered child runtime events and correlated response
  -> Rust acknowledge after response, or release on delivery/process failure
  -> canonical worker.progress + worker.started / worker.stopped
  -> renderer-neutral worker-changed
  -> OpenTUI worker.progress card and bounded footer summary
```

`send`, `steer`, and `follow-up` preserve message order. `wait` is the join and
seals further input. Rust stores the complete replayable envelope; UI truncation
is a view concern only and never mutates the journal, session, or handback data.
The presentation contract exposes state, type, and timestamps—not child prompts,
capability packets, process metadata, or hidden reasoning.
Safe progress adds active, queued, and maximum counts plus optional explicit
plan-step and task labels. On parent restart, Rust atomically abandons stranded
session-scoped leases; Octocode doesn't replay input with an uncertain delivery
outcome.

Interactive worker management is a separate renderer-neutral boundary. The
operations controller projects strict allowlisted inbox snapshots with a monotonic
generation, performs read-only list/inspect first, and binds send, follow-up,
steer, and graceful abort to the private worker routing identity retained inside
the controller. Force kill is a distinct intent and fails closed without explicit
host approval. The public snapshot never contains process IDs, prompts,
capabilities, model selections, terminal reasons, handback bodies, or hidden
reasoning. Slash commands and OpenTUI consume the same generation-scoped intent
vocabulary, so alternate/headless output retains the same semantics.

Native plan mutations use stable step IDs and optimistic revision preconditions.
Typed edit, reorder, dependency, reopen, approval, rejection, change-request, and
review-diff intents replace index drift and generic patch documents. Editing,
dependency changes, and reopening invalidate receipts and reopen every affected
downstream completed step. Both manual and worker-owned execution admit at most
four concurrent `doing` steps.

## Event, controller, and rendering layers

The native interactive path has five distinct layers:

| Layer                 | Owner                              | Responsibility                                                                                                                                |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime semantics     | `@octocodeai/agent-core`           | Versioned lifecycle events with typed canonical payloads and explicit opaque payloads, ordering, policy decisions, effects, and cancellation. |
| Native projection     | `native-runtime-presentation.ts`   | Translate canonical runtime events into renderer-neutral presentation events.                                                                 |
| Interactive control   | `native-interactive-controller.ts` | Own input routing, active-turn tracking, interactions, signals, slash commands, and teardown.                                                 |
| Presentation contract | `presentation/contracts.ts`        | Define the renderer-neutral port, snapshots, interaction types, widgets, and typed working/widget updates.                                    |
| OpenTUI adapter       | `terminal/opentui/`                | Reduce presentation events, manage toolkit state, render widgets, collect native input, and restore the terminal.                             |

```text
AgentRuntime RuntimeEvent
  -> native-runtime-presentation
  -> NativePresentationEvent
  -> NativeInteractivePresentationPort.accept
  -> OpenTUI presentation reducer/store
  -> widget controller and renderer

OpenTUI input action
  -> NativeInteractivePresentationPort subscription
  -> native-interactive-controller
  -> AgentRuntime command
```

Interactive question workflows use the same boundary:

```text
askUser questions + stable IDs
  -> native interaction workflow selects exactly one active question
  -> UiInteractionRequest with renderer-neutral workflow metadata
  -> interaction-requested / validation / resolved presentation events
  -> renderer returns answer | discuss | cancel
  -> workflow appends one answer or returns a typed partial ledger
```

Unknown `UiPort.present` values are decoded at the OpenTUI UI-port adapter. Once
accepted, working and widget updates are discriminated, typed presentation
events. Core, sessions, transports, and controllers never import OpenTUI values.
The presentation reducer is the state-transition authority; toolkit renderers
consume its view state and must not recreate runtime policy.

Runtime events are not dumped into the terminal. The native projector emits
bounded renderer-neutral activity for user-meaningful transitions, including
tools, workers, permissions, queued input, context usage, and compaction. Raw
inputs, policies, compaction summaries, and hidden reasoning stay outside visual
and alternate output. The terminal may say `Thinking…`; it must never render the
reasoning payload itself.

Every semantic widget owns bounded construction data, lifecycle transitions,
typed input intents, accessibility metadata, complete alternate output, and
literal agent-facing usage instructions. The widget controller owns projection,
focus, generation checks, and semantic announcements. The OpenTUI adapter owns
native controls, pointer events, layout, styling, and toolkit cleanup; it cannot
advance an ask workflow or interpret an answer.

OpenTUI also defines one adapter-private event family:
`PresentationEvent = NativePresentationEvent | runtime-widgets-changed`. The
additional event updates OpenTUI runtime-widget snapshots only and must not cross
back into the native presentation contract or core lifecycle vocabulary.

The launcher composes the ports and can publish runtime-owned plan or Awareness
projections. It must not mutate the OpenTUI store directly. The controller uses
the native projector and contract; a new renderer implements only
`presentation/contracts.ts` and doesn't import OpenTUI modules.

## Versioned native customization boundary

The package publishes deliberate, versioned customization entrypoints at
`octocode-agent/api/v1` and `octocode-agent/presentation/v1`. These entrypoints
adapt self-contained public contracts to the native composition root. They do not
export `NativeLaunchDependencies`, `createDefaultNativeRuntime`, registries,
stores, OpenTUI values, or other low-level launcher dependency bags.

```text
application
  -> octocode-agent/api/v1
     -> validate versioned customization
     -> native composition adapters
        -> agent-core policy, lifecycle, effects, and DurableCompactionService
        -> AgentControlV1
           -> submit | cancel | snapshot | subscribe | stop
        -> native interactive controller
           -> octocode-agent/presentation/v1 renderer-neutral port
              -> custom renderer
```

The boundary preserves the existing ownership model:

| Contribution   | Public choice                                                               | Owning invariant                                                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Presentation   | Implement the renderer-neutral presentation port.                           | The native interactive controller owns input routing, active turns, commands, cancellation, and ordered teardown. A renderer only presents events and returns typed input intents.                                                                                                   |
| Control        | Receive an `AgentControlV1` through the launch-scoped `onControl` callback. | The runtime owns submit, cancel, snapshot, stop, and event-ordering semantics. Control subscriptions receive immutable redacted runtime events. The launcher removes the subscriptions during teardown.                                                                              |
| Product policy | Prepend, append, or replace the product-policy component.                   | `native-prompt.ts` preserves the runtime-context and repository-instruction envelopes, then includes the resolved product policy in the prompt record and digest.                                                                                                                    |
| Tools          | Add validated tool definitions.                                             | The core tool pipeline still owns schema validation, trust, approval, policy, effect admission, settlement, concurrency, cancellation, and result ordering. Custom tools cannot replace the default registry or bypass the effect ledger.                                            |
| Hooks          | Subscribe to the supported lifecycle events.                                | Each event has fixed hook authority. Hooks receive immutable decision payloads marked `dataClassification: 'sensitive'`. The caller cannot promote an observe-only hook into a rewrite, context, stop, or allow/deny hook. Rewrites and decisions pass through lifecycle validation. |
| Events         | Observe redacted lifecycle envelopes.                                       | Observer payloads carry `dataClassification: 'redacted'`. Event observers are failure-isolated and cannot rewrite runtime state or make policy decisions.                                                                                                                            |
| Compaction     | Supply a summarizer or threshold.                                           | Core's `DurableCompactionService` still commits the attempt and validated projection before changing live context. The public API does not expose the session store or runtime compaction port.                                                                                      |

The API holds a lease on each programmatic contribution for the lifetime of its
run. Shutdown stops new lifecycle admission, cancels owned callbacks, and waits
for a bounded grace period after persistence-first cleanup. Pending callbacks are
then detached with late rejection consumed. Presentation and owned resources are
disposed in order; arbitrary same-process JavaScript is not forcibly terminated.

Direct inline callbacks remain root-local and fail closed with `--allow-workers`.
An integrity-bound portable ESM factory can instead recreate explicitly selected
tools, hooks, event observers, and compaction callbacks inside leaf workers.
`native-portable-customization.ts` owns module hash and deterministic manifest
validation. `native-worker-bootstrap.ts` owns the closed, bounded identity-bound
bootstrap frame delivered over inherited fd 3 before child runtime composition.
Worker tools are intersected with delegated capabilities; presentation remains
root-only. Data-only product-policy overlays use the same bootstrap rather than
an environment transport.

The CLI remains the same composition root and keeps its existing command and bin
behavior. The versioned API is an additional host-integration surface, not a
second runtime. See [Native customization API](docs/CUSTOMIZATION_API.md) for the
contract, examples, failure behavior, resolved hardening items, and rollout guidance.

The control event stream and lifecycle customization events are different ports.
`AgentControlV1.subscribe` exposes a redacted, observe-only runtime stream for an
embedding application. `OctocodeAgentCustomizationV1.events` registers selected,
failure-isolated lifecycle observers, while `hooks` registers decision-capable
lifecycle contributions with fixed authority. A control subscriber cannot become
a lifecycle hook or change runtime decisions.

## Native module flow

| Concern                             | Entry or owner                             |
| ----------------------------------- | ------------------------------------------ |
| Composition                         | `native-launcher.ts`                       |
| Runtime-to-session durability       | `native-runtime-session-projector.ts`      |
| Runtime-to-presentation translation | `native-runtime-presentation.ts`           |
| Interactive lifecycle               | `native-interactive-controller.ts`         |
| Renderer-neutral UI contract        | `presentation/contracts.ts`                |
| Terminal composition                | `terminal/opentui/create-terminal.ts`      |
| Presentation state and reducer      | `terminal/opentui/presentation.ts`         |
| Terminal Zustand store and selectors| `terminal/opentui/state/view-store.ts`     |
| Terminal layout policy              | `terminal/opentui/layout-policy.ts`        |
| Widget projection                   | `terminal/opentui/widget-controller.ts`    |
| Toolkit materialization             | `terminal/opentui/opentui-adapter.ts`      |
| Terminal renderer                   | `terminal/opentui/renderer.ts`             |
| Noninteractive output               | `native-transports.ts` and `native-acp.ts` |

## Dependency rules

- Do not import Pi, the Pi extension, or `agent-testing` from production code.
- Do not import internal `index.ts` modules or wildcard barrels. Use the module
  that owns the symbol. Public package entrypoints are deliberate API composition
  roots and are not internal import shortcuts.
- Keep policy, effect, session, and lifecycle semantics in agent-core. Native
  code supplies ports and adapters; UI and transport code only project state.
- Rust owns durable transactions, indexes, leases, revisions, integrity
  primitives, and contained filesystem syscalls. It does not own file-tool
  schemas/edit semantics, model/provider behavior, MCP semantics, policy,
  prompts, UI, or OS child-process supervision.
- External programs such as FFmpeg receive only workspace paths authorized by
  the capability-rooted Rust filesystem service. The authorization RPC proves an
  existing regular input or a symlink-free prospective output parent and returns
  a strict adapter-only host path. TypeScript still owns argv meaning, policy,
  effects, approval, process supervision, cancellation, and stream limits.
- Decode durable session records and worker RPC envelopes through the strict
  agent-core parsers. Native adapters can add transport checks such as event
  sequence and request correlation, but they must not cast partially validated
  data into core contracts.
- Use `@octocodeai/config` and shared path helpers for environment and home
  resolution. Do not create another resolver.
- Keep provider, MCP, ACP, and telemetry protocols behind adapters. Their SDKs do
  not own the canonical runtime loop, effect ledger, or session store.
- Treat raw lifecycle events as debug data. Export operational telemetry only through
  the redacted, versioned `monitoring.snapshot` contract.
- Compose compaction only through the core durable service and runtime port.
  Transport and UI adapters can request or cancel it, but they must not mutate
  model history or session projections directly.

## Known convergence work

- The external Octocode catalog does not supply authoritative effect and
  lock-target metadata, so the native tool adapter still infers risk locally.
- Some launcher and discovery paths still read the settings storage adapter
  directly instead of resolving every value through one `SettingsService`.
- Rust-backed sessions commit project, parent, and update index metadata in the
  same transaction as their events. Continue and parent, child, previous, and
  next navigation read that Rust index. The package build ships the platform
  actor beside the launcher and the built CLI fails closed when it is missing.
- A crash-left `started` effect is terminalized as `uncertain` before replay;
  the runtime never re-executes it. Missing sessions are rejected consistently
  by resume and fork instead of becoming revision-zero phantom sessions.
- The Rust actor also exposes revisioned settings, leased communication queues,
  lifecycle streams, the automation ledger, and dependency-work graphs. The
  launcher adopts these only through strict conformance ports; settings
  validation and redaction, Awareness acknowledgement, scheduling, worker
  execution, and semantic execution stay in their owners. Dependency schedules
  are explicitly model-driven: the root invokes `worker.schedule` for the active
  plan. A fencing-token takeover terminalizes the abandoned item as uncertain
  failure instead of replaying a worker that may already have executed. No
  persisted Rust record can initiate worker execution by itself.
- Real-host Pi/native conformance covers only the scenarios driven through both
  production compositions. Unsupported scenarios remain release blockers.

Program-level open decisions and closure gates are in
[`DESIGN/LEFTOVERS.md`](../../DESIGN/LEFTOVERS.md).
