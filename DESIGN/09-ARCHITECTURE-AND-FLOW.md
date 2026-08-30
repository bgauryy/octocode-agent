# Architecture and executable flow

Status: required target architecture and decision ledger

This document reconciles the implementation-facing designs with the actual package graph. It defines package ownership, dependency direction, production composition roots, executable flows, and the remaining architecture decisions. Detailed behavior remains owned by [Agent Runtime and Tools](02-AGENT-RUNTIME-AND-TOOLS.md), [Sessions and Compaction](03-SESSIONS-AND-COMPACTION.md), [TUI and Settings](04-TUI-AND-SETTINGS.md), [the RFC hooks and plugins specification](pi-coding-agent-removal/HOOKS_AND_PLUGINS.md), and [Conformance, Security, and Operations](06-CONFORMANCE-SECURITY-AND-OPERATIONS.md).

## Architectural verdict

The coarse package direction is already mostly correct:

- `@octocodeai/agent-core` has no runtime package dependencies.
- native `octocode-agent` depends on core and has no Pi dependency;
- Pi-specific host types and packages stay inside `@octocodeai/pi-extension`; and
- OpenTUI stays under the native terminal adapter.

The remaining problem is semantic ownership. Effect classification, policy gates, settings definitions, tool registration, and conformance composition are still reconstructed differently by the native and Pi paths. A clean import graph is necessary but insufficient: both hosts must execute the same canonical decisions before an adapter performs an effect.

## Current dependency graph

Arrows mean “depends on.” Dashed lines mean process or structural integration rather than a normal TypeScript import.

```text
@octocodeai/agent-core
  -> no runtime npm dependencies

octocode-agent
  -> @octocodeai/agent-core
  -> @octocodeai/config
  -> @octocodeai/octocode-awareness
  -> @opentui/core
  -> octocode
  -> web-tree-sitter
  -- npx subprocess --> octocode CLI tools/catalog

@octocodeai/pi-extension
  -> @octocodeai/agent-core
  -> @octocodeai/octocode-awareness
  -> external Octocode engine/MCP packages
  -> Pi host and Pi TUI packages
  -> @octocodeai/config at build time

@octocodeai/agent-testing
  -> no workspace production package
  -- caller-supplied handlers --> synthetic Pi/native-shaped scenarios
```

Evidence:

- Core's manifest has no `dependencies`, `peerDependencies`, or `optionalDependencies`: [agent-core package](../packages/octocode-agent-core/package.json).
- Native's declared runtime dependencies are listed in [native package](../packages/octocode-agent/package.json), and its launcher composes core directly in [native-launcher.ts](../packages/octocode-agent/src/native-launcher.ts).
- The independent Pi adapter declares core, Pi, Awareness, engine, MCP, and UI dependencies in [Pi-extension package](../packages/octocode-pi-extension/package.json). Those dependencies remain isolated from native agent/core and native release artifacts.
- The conformance package exposes a structural handler interface rather than production host factories in [host-conformance.ts](../packages/octocode-agent-testing/src/host-conformance.ts).

Current semantic breaks:

- Native infers tool effect policy from catalog category or name in [native-tools.ts](../packages/octocode-agent/src/native-tools.ts), then its production policy allows every read and network effect in [native-launcher.ts](../packages/octocode-agent/src/native-launcher.ts).
- Native now composes the core plan-policy state and fail-closed lock-target gate. The external catalog still lacks authoritative lock-target metadata, and native has no peer-lock checker for a future non-empty target set, so cross-host peer-lock conformance remains open.
- Pi lifecycle translation uses core, but Pi production tools still register through the Pi-local funnel in [octocode-tools.ts](../packages/octocode-pi-extension/src/tools/octocode-tools.ts); the canonical Pi registry adapters are exported but are not the production registration root.
- Core owns the canonical settings service; native consumes it and Pi exposes an adapter, while complete cross-host value and mutation conformance remains open.
- Core now receives `cwd` through its runtime options and the package boundary rejects host filesystem, Pi, OpenTUI, and launcher imports. The remaining host-neutrality risk is semantic conformance, not an ambient `process.cwd()` dependency.

## Target dependency graph

```text
                         +-------------------------+
                         | @octocodeai/agent-core  |
                         | contracts + semantics   |
                         | zero runtime deps        |
                         +------------+------------+
                                      ^
                         imports      |      imports
                       +--------------+--------------+
                       |                             |
          +------------+------------+   +------------+-------------+
          | native octocode-agent   |   | @octocodeai/pi-extension |
          | composition + adapters  |   | independent Pi adapter   |
          +---+----+----+----+------+   +---+----+----+-------------+
              |    |    |    |              |    |    |
              |    |    |    +-> OpenTUI    |    |    +-> Pi host/TUI
              |    |    +------> config     |    +------> config
              |    +-----------> Awareness  +-----------> Awareness
              +----------------> supported external tool/model facade

@octocodeai/agent-testing -> @octocodeai/agent-core

test-only conformance composition
  -> @octocodeai/agent-testing
  -> native host factory
  -> Pi host factory
```

Dependency rules:

- `agent-core` has no runtime dependency on any workspace or external package.
- Native and Pi adapters import core; core never imports them.
- Native never imports Pi or the Pi extension.
- The Pi extension never imports native launcher, terminal, session, or settings implementations.
- Awareness and config remain inward leaf services. They do not depend on agent-core; host adapters translate their data and capabilities into core ports.
- External tool/model packages do not depend on a host UI. A host adapter maps their supported public API into core ports.
- Production hosts never depend on `agent-testing`.
- A test-only integration composition may depend on both hosts; no production package may do so.

## Package ownership matrix

| Package or boundary              | Owns                                                                                                                                                                                                                                                                                                                                                                                  | Supplies to core                                                                   | Must not own                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@octocodeai/agent-core`         | Versioned commands/events/errors; runtime state machine; prompt and model-visible context rules; tool/command registries; canonical effect set; pre-effect policy order and receipts; lifecycle decisions; execution scopes; session projection/compaction contracts; settings/model contracts and service semantics; hook/plugin contracts and transactional registries; RPC schemas | Nothing host-specific                                                              | Filesystem, browser, process spawning, OpenTUI, Pi types, Awareness database access, provider HTTP payloads, launcher UX                               |
| native `octocode-agent`          | CLI parsing; native composition root; filesystem session/settings adapters; provider adapter; supported tool facade adapter; process adapter; Approval UI/port; Awareness trust/plan/lock adapters; print/JSON/RPC transports; OpenTUI projection and lifecycle                                                                                                                       | Concrete ports, runtime mode, cwd, startup config, event sink                      | Canonical policy order, alternative tool contracts, session semantics, settings precedence, plugin grants, provider-specific types in public events    |
| `@octocodeai/pi-extension`       | Supported Pi-version boundary; Pi event/tool/command/UI/session translation; Pi-host lifecycle binding; Pi-specific compatibility errors; packaged Octocode tools/skills/prompt assets                                                                                                                                                                                                | Concrete Pi-backed ports and translated canonical events/results                   | Product policy decisions, duplicate canonical tool/command/settings types, native implementation imports, direct mutation outside canonical registries |
| `@octocodeai/agent-testing`      | Canonical scenarios, deterministic fixtures, trace normalization, comparison, effect ledger, fault controls, adapter test interfaces                                                                                                                                                                                                                                                  | Test-only contracts and utilities                                                  | Production behavior, synthetic success standing in for a host, host-specific policy decisions, production package dependencies on testing              |
| `@octocodeai/octocode-awareness` | Coordination, memory, plan/lock/trust records, receipts, and its storage/protocol                                                                                                                                                                                                                                                                                                     | Host adapters expose immutable trust/plan/lock facts and record canonical receipts | Agent runtime state machine, tool execution, UI approval, direct dependency on agent-core                                                              |
| `@octocodeai/config`             | Octocode home, env propagation/parsing, protected keys, config loading                                                                                                                                                                                                                                                                                                                | Host startup/config adapter inputs                                                 | Agent settings registry, model catalog, runtime policy, UI, direct dependency on agent-core                                                            |
| External tool brain/facade       | Tool catalog, exact schemas, argument preparation where tool-specific, actual capability/effect declaration, execution, provider/security behavior, cancellation support                                                                                                                                                                                                              | Supported public catalog/executor port with version identity                       | Runtime policy decisions, approval, plan/lock evaluation, terminal rendering, session mutation outside a tool contract                                 |

## Forbidden dependencies and knowledge

The following are architecture violations even if they compile:

- `agent-core -> octocode-agent`, `agent-core -> pi-extension`, or `agent-core -> agent-testing`.
- `agent-core -> Pi`, OpenTUI, browser, filesystem, process, Awareness, config, provider SDK, or external tool implementation types.
- `octocode-agent -> pi-extension` or any Pi package.
- `pi-extension -> native launcher`, native OpenTUI, native filesystem stores, or native transports.
- either production host importing `agent-testing`.
- UI or transport code deciding trust, plan, peer-lock, effect class, hook authority, or approval validity.
- a tool adapter lowering risk inferred from the authoritative tool capability declaration.
- hooks or plugins receiving unrestricted registries, filesystem/process objects, raw secrets, or host-private context.
- session persistence invoking model/provider logic, or model adapters mutating session state directly.
- structured stdout depending on console/logging behavior outside its transport encoder.

Static boundary checks must cover imports, dynamic imports, globals such as `process`, type-only imports, package manifests, and bundled output. String scans alone are a backstop, not proof of semantic ownership.

## Composition roots

### Core

Core is a library, not an application composition root. `createRuntimeKernel` accepts every capability it needs. Required context such as cwd, mode, time, identity, trust reader, policy services, session controller, and event sink is injected; it must not fall back to ambient process state.

### Native

The native production composition root is `createDefaultNativeRuntime` in [native-launcher.ts](../packages/octocode-agent/src/native-launcher.ts). Its target responsibilities are:

1. load config through `@octocodeai/config`;
2. create the canonical settings registry/service with native storage ports;
3. resolve a session controller and recover/project the selected session;
4. resolve the effective model catalog, model, and thinking capability;
5. load the authoritative tool catalog and executor facade;
6. create Awareness-backed trust, plan, and peer-lock adapters plus an approval port;
7. load reviewed hooks and authorized plugins through host adapters;
8. create provider, process, UI, persistence, and event ports;
9. create one core runtime; and
10. attach exactly one transport, subscribing before start and remaining through stop.

The launcher may choose adapters and presentation. It may not replace canonical policy with a permissive local shortcut.

### Independent Pi compatibility adapter

The pinned extension factory in [Pi extension index](../packages/octocode-pi-extension/src/index.ts) is the independent Pi composition root and conformance reference. It must:

1. assert the supported Pi host version;
2. create or receive the canonical registries/services;
3. bind Pi events to canonical lifecycle buses;
4. register canonical tools and commands through Pi registry adapters;
5. translate Pi trust/session/model/UI capabilities into core ports;
6. preserve Pi-only presentation and compatibility behavior only at the extension boundary; and
7. execute the same canonical pre-effect decisions as native.

Direct Pi registrations remain adapter-local compatibility code until every shared production registration is projected through the canonical registry. Native release closure removes migration selectors and proves that this composition root is unreachable from native source, dependencies, artifacts, installers, updates, and rollback paths.

### Settings page

There is one canonical `SettingsRegistry` and `SettingsService` composition per effective configuration scope. Native CLI, native HTML, Pi HTML, model selection, hooks, and plugins use that service. Hosts contribute storage and action capabilities; they do not create competing definitions for the same key.

### Control plane

The canonical product vocabulary is **Ask**, **Plan**, **Delegate**, and **Configure**. It names semantic ownership, not four new services:

| Term | Semantic owner | Host projection | Evidence boundary |
|---|---|---|---|
| Ask | Core interaction request/result contract; runtime owns request lifetime | OpenTUI, headless, JSON/RPC, ACP, and Pi presentation | Native broker/tool exist at `native-interactions.ts:30-150`; mode and cross-host parity remain open |
| Plan | Runtime owns the active session plan and policy snapshot; Awareness owns shared DAG/task/work records | Plan widget, commands, RPC/ACP, and Pi projection | `native-plan.ts:20-123` is implemented; shared-authority restart/conformance remains open |
| Delegate | Runtime worker supervisor owns process lifecycle; Awareness owns durable coordination/mailbox/handoff records | Worker tool plus UI/RPC/ACP/Pi controls | `native-worker-tool.ts:31,386-390` and launcher composition exist; clean multi-process/platform proof remains open |
| Configure | Core SettingsRegistry/SettingsService owns definitions, effective values, revisions, and mutations | HTML, CLI, OpenTUI, RPC/ACP, and Pi projections | `native-settings-page.ts:12-15,161-180` is production-reachable; complete action/conformance proof remains open |

**Connections** is Configure's namespace for providers and external services. MCP Servers, Tools, Resources, Prompts, and **MCP Tasks** belong beneath Connections. The shipped native section inventory contains `connections` and no separate `add-server` entry at `native-settings-page.ts:12-15`. Its Connections section renders the model endpoint, MCP server/tool controls, and the negotiated-capability note for MCP Tasks together at `native-settings-page.ts:181`; native task get/result/cancel operations exist at `native-mcp.ts:677-712`. Real negotiated MCP Tasks behavior against a live supported server and the Pi/native conformance matrix remain open.

### Conformance

The conformance root is test-only. It instantiates the actual Pi and native production factories with deterministic provider, process, filesystem, trust, approval, plan, lock, UI, and clock ports. It records canonical events and effects through `agent-testing`. Scenario handlers drive hosts; they do not manufacture host success events.

## Authoritative executable flows

### Startup

```text
launcher/extension entry
  -> parse and validate external input
  -> load config and redacted effective settings
  -> recover/select session and projection
  -> resolve model catalog/default/thinking
  -> load authoritative tool catalog
  -> resolve trust + managed policy + plan + lock snapshot
  -> discover/review hooks and plugins
  -> validate all required capabilities
  -> construct one runtime root scope
  -> subscribe transport/event persistence
  -> runtime.starting
  -> activate startup-safe contributions transactionally
  -> runtime.ready
```

Startup fails before ready when a required capability is invalid or unavailable. Optional capabilities produce explicit degraded status. No model, tool, hook, plugin, UI, or child process may outlive the runtime root scope.

### Turn and model flow

```text
validated submit
  -> create turn scope and identity
  -> input pre-lifecycle decisions
  -> project model-visible session history
  -> assemble trusted prompt fragments
  -> resolve frozen model + thinking controls
  -> provider attempt scope
  -> normalized text/thinking/tool-call deltas
  -> usage + stop/error classification
  -> tool flow when calls exist
  -> next bounded provider attempt or final assistant result
  -> persist model-visible and diagnostic records
  -> exactly one turn.ended
```

Steer targets an active turn at a declared model-safe point. Follow-up queues a new turn in stable FIFO order. Neither is relabeled as submit. A transport input pump remains live while the turn runs.

Retries belong to core policy. A provider adapter classifies outcomes and retry metadata but does not independently replay a logical turn. A retry is permitted only before an unrepeatable effect begins, or when the effect ledger proves completed call identities cannot execute again.

### One authoritative pre-effect order

External protocol parsing and version validation occur before this sequence. Every model call, tool call, process launch, filesystem/network mutation, hook handler, plugin activation, settings mutation, session mutation, UI-open action, and external message then passes through this order as applicable:

```text
1. Prepare/normalize arguments without effects
2. Validate schema and cross-field invariants
3. Resolve the authoritative effect set
4. Run eligible context/rewrite hooks through their own trust and authority boundary
5. If rewritten, restart preparation, validation, and effect resolution
6. Resolve workspace trust and managed-only policy
7. Evaluate plan policy
8. Evaluate peer-lock conflicts
9. Run eligible blocking decision hooks through their own trust and authority boundary
10. If rewritten, restart all gates at preparation and invalidate prior receipts
11. Request approval bound to the final argument digest and final effect set
12. Reserve the shared effect ledger entry and create the owned execution scope
13. Execute exactly once
14. Validate and redact updates and the terminal result
15. Persist the result and finalize the effect receipt
16. Emit the correlated public terminal event
```

Rules:

- Deny wins.
- Missing required trust, plan, lock, hook, or approval input denies.
- Hook eligibility is not authority. Before a hook executes, its exact definition hash, source trust, managed-only eligibility, declared event authority, handler capability, timeout, and execution restrictions are validated independently. Command or MCP hook execution is itself an owned effect and cannot inherit approval from the operation it observes.
- Context/rewrite hooks run before trust, plan, and lock evaluation so those gates evaluate the candidate operation. A rewrite restarts preparation, schema validation, and effect resolution.
- Blocking decision hooks run only after trust, managed, plan, and peer-lock gates allow them to be reached. If a blocking hook rewrites the operation, all gates restart; no earlier allow or approval survives.
- An allow receipt is bound to exact operation identity, tool/plugin provenance, final effect set, final prepared-argument digest, policy revisions, and expiry.
- Any rewrite that changes those values invalidates affected receipts and the ledger reservation, if any.
- Approval is last among interactive gates so the runtime does not request approval for an operation already denied elsewhere.
- The shared effect-ledger reservation and owned scope are created only after final approval. Execution cannot start without both.
- There is exactly one terminal result. A persistence or observer failure cannot silently repeat an effect.

### Tool flow

```text
finalized model tool call
  -> stable call ID and ordered assistant toolCalls history
  -> registry lookup
  -> authoritative preparation/schema/effect metadata
  -> pre-effect order above
  -> tool.started
  -> zero or more validated/redacted tool.updated events
  -> exactly one success/error/blocked/cancelled tool.ended
  -> correlated tool result persisted
  -> correlated tool message passed to the next model request
```

The external tool brain owns tool-specific execution truth; core owns whether it may execute in the current context. The adapter cannot infer a lower effect class from names or categories. Composite effects are preserved.

### Session flow

```text
select/create/import source
  -> load immutable record at revision
  -> validate envelope and event graph
  -> deterministic projection
  -> choose active branch/leaf
  -> expose model-visible history separately from transcript/diagnostics
  -> run commands through SessionController
  -> expected-revision transaction
  -> durable commit or typed conflict
  -> publish new projection
```

Resume and continue feed the projected model-visible history into the first prompt. Import reads a stable legacy/Pi source and writes a distinct destination; it never mutates the source. `--no-session` uses a memory adapter and performs no durable write. Compaction is a session transaction with bounded retry, cancellation, and one terminal state.

### Settings flow

```text
CLI/HTML/RPC/Pi action as unknown
  -> canonical action-schema parse
  -> authentication/origin/token/body checks at adapter boundary
  -> SettingsService capability/trust/policy check
  -> resolve current stored/effective revision
  -> normalize and validate candidate value
  -> compute redacted preview and dependency impact
  -> confirmation when required
  -> expected-revision storage transaction
  -> refresh derived model/hook/plugin catalogs
  -> redacted mutation result and audit receipt
```

UI code never writes settings files. Default provider and model commit atomically and resolve against the effective model catalog. Raw secret-bearing records never enter public projections.

### Hook flow

```text
canonical lifecycle event
  -> collect managed/user/trusted-workspace/session/plugin sources
  -> validate source and exact-hash review
  -> apply matcher
  -> create redacted bounded input
  -> execute in owned hook scope with deadline
  -> validate/redact output
  -> normalize decision/context/rewrite/diagnostic
  -> aggregate in deterministic source and declaration order
  -> return receipts to the governing runtime operation
```

Blocking hooks execute inside the pre-effect order. Async observational hooks cannot approve, deny, or rewrite and run only through a bounded runtime-owned queue. MCP hooks use existing connections, do not recurse, and cannot bypass normal approval or tool policy.

### Plugin flow

```text
discover candidate
  -> parse/canonicalize manifest
  -> realpath containment and trust review
  -> bind grant to plugin ID + manifest hash + revision + scope + expiry
  -> open owner-bound contribution transaction
  -> validate each declaration against grant
  -> activate in owned scope
  -> commit all contributions atomically
  -> register leases for active work
```

Disable/update/unload stops new work, cancels or drains owned scopes, waits for zero leases, then removes contributions transactionally in reverse order. Failed update leaves the prior version active. Plugins receive narrow capability ports and cannot mutate registries outside their transaction.

### Shutdown

```text
runtime.stop request or terminal failure
  -> reject new submit/steer/follow-up/effects
  -> cancel queued work and root scope
  -> abort provider readers and process/tool/hook/plugin children
  -> drain or cancel async hook queues
  -> flush defined partial assistant/session state
  -> wait for zero owned children and leases
  -> persist terminal turn/session state
  -> emit runtime.stopping
  -> close adapters/transports
  -> emit runtime.stopped exactly once as final runtime event
```

No event or completion may return a stopped runtime to ready. Idle cancellation is a no-op or typed not-active result; it never poisons a later turn.

### Conformance

```text
canonical scenario + deterministic ports
  -> actual Pi composition                 actual native composition
  -> canonical event/effect recorder       -> canonical event/effect recorder
  -> semantics-preserving normalization
  -> first-divergence comparison + trace/effect hashes
  -> zero-bypass, zero-duplicate-effect, zero-leak assertions
```

Pure mode allows no effects. Shadow mode lets the candidate propose effects but the shared ledger blocks execution. Live mode designates exactly one executing host. Normalization may remove representation noise but cannot erase identity relationships, ordering, ancestry, policy decisions, effect correlation, paths relevant to containment, visibility, errors, or terminal reasons.

## Ecosystem protocol and context flow

The native runtime adds protocol adapters without giving them state ownership:

```text
Editor / IDE
    |
    | ACP initialize, session, prompt, progress, permission, fs, terminal, MCP
    v
Native ACP adapter -------- generated schema / conformance fixtures
    |
    v
AgentRuntime + SessionController + PolicyKernel + UiPort
    |                    |                    |
    |                    |                    +--> client-mediated effects
    |                    +--> native session/checkpoint store
    +--> prompt/context pipeline
             |
             +--> trusted hierarchical instructions
             +--> budgeted AST/LSP semantic map
             +--> policy-filtered deferred tool schemas
             +--> cache-stable prompt prefix + variable turn suffix
```

ACP never owns session records, permissions, tools, or terminal state. It maps upstream methods into canonical ports and projects canonical events back into ACP updates. Native JSON/RPC remains the Octocode automation protocol; ACP is the editor interoperability protocol.

MCP durable tasks are a separate versioned adapter below the persistent MCP catalog and appear to users under Configure → Connections → MCP Tasks. The adapter negotiates one pinned extension revision, binds task state to authorization context, and delegates task persistence/cancellation to runtime-owned scopes. Generic MCP connectivity must not imply task support.

A2A is outside the cutover graph. If a real remote-agent consumer appears after native release, an authenticated A2A transport/plugin may map Agent Cards and remote tasks onto canonical runtime/worker ports. It cannot replace Awareness as the internal coordination authority.

Checkpoint review composes the session controller, filesystem checkpoint port, semantic diff projection, OpenTUI widget, and ACP/editor update. Restore mode is explicit: files only, conversation only, or both. Every restore checks the expected source revision and preserves a recovery point before mutation.

## Architecture decisions

### Accepted

1. `@octocodeai/agent-core` is the sole host-neutral semantic owner and has zero runtime dependencies.
2. Native and the independent Pi extension are sibling adapters that depend inward on core; neither depends on the other.
3. `@octocodeai/pi-extension` is an independently installed, version-pinned Pi compatibility product and conformance reference outside native release wiring.
4. Native OpenTUI is adapter-private and never enters core, Pi, print, JSON, or RPC boundaries.
5. Awareness and config remain independent leaf services consumed through host adapters.
6. One canonical pre-effect order governs every host and transport.
7. Settings definitions and mutations flow through one registry/service composition.
8. Real-host conformance lives in a test-only composition and cannot be satisfied by synthetic success handlers.
9. Internal modules import concrete owners directly. Public package entrypoints remain deliberate API composition roots.
10. The native runtime keeps its Octocode-owned kernel; XState, Effect, AI SDK, and OpenAI Agents do not replace runtime ownership.
11. Official SDKs own external wire protocols: OpenAI Responses for the provider adapter, MCP for context/tool servers, and ACP for editor interoperability.
12. Awareness remains the durable local worker/mailbox substrate. A2A is reserved for a future approved remote-agent boundary.
13. OpenTelemetry GenAI conventions may receive a redacted event projection; they do not replace canonical lifecycle events.
14. Ask, Plan, Delegate, and Configure are the canonical control-plane terms; MCP Tasks is subordinate to Configure → Connections.

### Open ADRs and partially implemented decisions

#### ADR-01 — Q5 runtime/provider ownership

The source RFC confirms temporary retention of `pi-agent-core` and `pi-ai` in [Implementation Q5](pi-coding-agent-removal/IMPLEMENTATION.md), while the actual native implementation owns both the model/tool loop and OpenAI-compatible provider adapter. Resolve explicitly:

- accept the reopened Q5 and document evidence supporting the Octocode-owned implementation; or
- restore retained Pi-independent adapters behind core ports.

Until resolved, documentation and implementation describe different approved architectures. The decision must also settle whether provider adapters live in native, a separate external package, or an external engine facade.

#### ADR-02 — Supported external tool facade

Choose one production boundary:

- a versioned in-process external tool API; or
- a pinned/bundled CLI protocol with explicit executable resolution and version handshake.

The native facade now validates catalog kind, version, and count; rejects duplicate or malformed tool entries; validates JSON execution output and published output schemas when present; supports cancellation; and returns typed redacted failures. This is a fail-closed implementation increment, not an accepted boundary.

The production route still resolves and invokes `npx octocode`, and the upstream catalog still omits authoritative effect metadata, lock-target semantics, and some output schemas. ADR-02 therefore remains open: the selected boundary must be pinned and supply the complete authority contract rather than rely on native name/category inference.

#### ADR-03 — Composite effect model

Core now defines a canonical, non-empty `EffectSet`; policy, admission receipts, the runtime gate, and native tool registrations preserve the set. Focused tests cover canonical ordering, duplicate removal, empty sets, unknown effects, composite admission, and receipt mismatch.

The decision is only partially implemented. The external catalog omits authoritative effects and lock targets, so the native Octocode facade still infers them from tool name/category. Complete ADR-03 by moving that authority upstream. Define conservative approval and lock-target rules for every combination, and prove adapters can raise but never lower risk.

#### ADR-04 — Conformance integration placement

Keep `agent-testing` production-neutral while enabling real-host tests. Recommended shape:

- `agent-testing` depends only on core contracts;
- each host exports a test-only factory or its own conformance adapter from a non-production entry;
- a root/test-only integration project dev-depends on testing and both hosts.

Resolve packaging, build order, fixture ownership, and how Pi host version matrices run without creating production cycles.

#### ADR-05 — Canonical runtime API and schema authority

The RFC example uses `submit(AgentInput)`, async event iteration, and `abort`, while current core exposes `start`, string `submit`, `cancel`, `execute`, synchronous subscription, and `stop` in [runtime contracts](../packages/octocode-agent-core/src/contracts/runtime.ts). Select the canonical API, version it, derive RPC/JSON schemas from it, and declare which document supersedes conflicting examples. Steer/follow-up operation identity and asynchronous command acknowledgement must be part of this decision.

#### ADR-06 — Host-neutral ambient capabilities

The runtime kernel receives cwd and clock through composition, and core no longer calls `process.cwd()`. This is a partial implementation. Decide and inject the remaining identity generation, timers, randomness, scheduling, and cancellation capabilities, then expand boundary checks beyond imports.

#### ADR-07 — Canonical settings composition lifecycle

Decide where the single settings registry is constructed, how host-only contributions register without duplication, how scope instances are cached/disposed, and how native CLI and Pi/browser actions address the same effective service.

#### ADR-08 — Policy receipt and effect-ledger durability

Core now defines a versioned admission receipt containing operation, exact JSON-compatible input, composite effects, trust, approval, plan revision, lock targets, and ordered policy receipts. Admission rejects altered receipts, and the native launcher persists the receipt with reservation/finalization state so reconstructed calls fail closed.

ADR-08 remains open for stable digest inputs, expiry and policy-revision rules, crash recovery, concurrency semantics, retention, and a shared cross-host persistence owner. Those decisions require restart/retry and duplicate-effect proof before cutover.

## Completion gates

Architecture is implemented only when:

- dependency guards prove the target graph in source, manifests, and bundled output;
- core contains no ambient host access or forbidden implementation knowledge;
- native and Pi production paths register the same canonical tool/command/settings contracts;
- the same pre-effect evaluator and receipt schema govern every host and transport;
- authoritative composite effects reach core without name/category inference;
- production startup composes prompt, sessions, model controls, policy, hooks, plugins, and settings rather than isolated primitives;
- shutdown joins every owned scope and emits one final lifecycle sequence;
- the real-host conformance root runs all mandatory scenarios with shared effect-ledger enforcement; and
- every open ADR above is accepted, superseded, or explicitly blocks cutover.

No Pi removal, native-default promotion, or completion checkbox may use package import cleanliness as a substitute for these executable-flow gates.
