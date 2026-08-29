# Native agent architecture

`octocode-agent` is the native host adapter and composition package. It depends
inward on `@octocodeai/agent-core`; core never imports this package.

## Ownership

- `native-launcher.ts` composes the runtime, sessions, settings, model, tools,
  policy, Awareness, interactions, and transports. Interactive startup and
  teardown share one cleanup boundary, including renderer initialization
  failures.
- `native-provider-registry.ts` is the model composition boundary. It composes the
  canonical, persisted-settings, and environment model sources into the core
  `ModelCatalog`; runtime selection is validated against that effective catalog.
  `native-model.ts`, `native-openai-responses-model.ts`, and
  `native-anthropic-messages-model.ts` own OpenAI Chat Completions, OpenAI
  Responses, and Anthropic Messages translation. External credentialed provider
  conformance remains a release gate.
- `native-mcp.ts` uses the official MCP client with session-owned connection
  reuse, negotiated catalog invalidation, reconnect, progress, and shared
  shutdown. Elicitation, provenance, durable Tasks, and real-host fault matrices
  remain open.
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
- `native-signal-scope.ts` owns first-signal semantics and bounded cleanup for
  print, JSON, RPC, and ACP transports. `native-transports.ts` and
  `native-acp.ts` translate that lifecycle without owning runtime state.
- Durable compaction is composed in `native-launcher.ts` through the core
  `DurableCompactionService`. Attempt state and the validated projection are
  committed to the session store before live context changes. Resume rebuilds
  summary-plus-retained context from the committed record.
- `terminal/opentui/presentation.ts` owns semantic presentation state and the
  Zustand store. `create-terminal.ts` is the terminal composition root.
  Controllers and widgets import their concrete owners directly.
- `terminal/opentui/renderer.ts` and `opentui-adapter.ts` are the only OpenTUI
  toolkit boundary. OpenTUI values never enter core, sessions, or transports.
- `@octocodeai/octocode-shared` owns shared paths, protocols, prompt fragments,
  entities, and discovery helpers. Native code imports its published subpaths
  instead of recreating policy or importing the aggregate package root.

## Dependency rules

- Do not import Pi, the Pi extension, or `agent-testing` from production code.
- Do not import internal `index.ts` modules or wildcard barrels. Use the module
  that owns the symbol. Public package entrypoints are deliberate API composition
  roots and are not internal import shortcuts.
- Keep policy, effect, session, and lifecycle semantics in agent-core. Native
  code supplies ports and adapters; UI and transport code only project state.
- Decode durable session records and worker RPC envelopes through the strict
  agent-core parsers. Native adapters can add transport checks such as event
  sequence and request correlation, but they must not cast partially validated
  data into core contracts.
- Use `@octocodeai/config` and shared path helpers for environment and home
  resolution. Do not create another resolver.
- Keep provider, MCP, ACP, and telemetry protocols behind adapters. Their SDKs do
  not own the canonical runtime loop, effect ledger, or session store.
- Compose compaction only through the core durable service and runtime port.
  Transport and UI adapters can request or cancel it, but they must not mutate
  model history or session projections directly.

The canonical program-wide package graph and open decisions are in
[`DESIGN/09-ARCHITECTURE-AND-FLOW.md`](../../DESIGN/09-ARCHITECTURE-AND-FLOW.md).
