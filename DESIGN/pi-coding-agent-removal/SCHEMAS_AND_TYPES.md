# Schemas and types: Agent core and Pi-extension compatibility

> Ownership: `RFC.md` §Package boundaries. Operational order: `STEPS.md`. Migration: `MIGRATION_STAGES.md`. Hooks/plugins: `HOOKS_AND_PLUGINS.md`. Native terminal mapping: `OPENTUI_TERMINAL_CORE.md`. Settings and models: `SETTINGS_WEB_UI.md`. Mandatory validation: `TEST_PLAN.md`.

## Contract ownership

`packages/octocode-agent-core/` owns canonical production types and runtime-validation schemas. During migration, `packages/octocode-pi-extension` imports those contracts and translates Pi host inputs into them. Agent core never imports the Pi extension or a Pi package, and the final retirement release deletes the temporary adapter.

```text
packages/octocode-agent-core
  contracts + schemas + kernel + ports
          ^                    ^
          |                    |
octocode-agent composition   pi-extension adapter
                              |
                          Pi host APIs
```

This dependency direction lets Octocode remove `pi-coding-agent` from its native runtime while continuing to publish and test a Pi extension for Pi-host users.

## Planned module layout

| Planned module under `packages/octocode-agent-core/src/` | Owner responsibility |
|---|---|
| `contracts/runtime.ts` | Runtime commands, snapshots, state, and execution scope types |
| `contracts/events.ts` | Versioned lifecycle and streamed event unions |
| `contracts/tools.ts` | Tool schema, execution, update, result, error, and policy metadata |
| `contracts/commands.ts` | Command registration, completion, and command-context capabilities |
| `contracts/sessions.ts` | Session identity, events, projections, branches, compaction, and migration |
| `contracts/ui.ts` | Semantic interaction requests and presentation-state commands |
| `contracts/model.ts` | Model identity, request, delta, usage, stop, retry, and provider errors |
| `contracts/models.ts` | Model/provider catalog entries, capabilities, sources, provenance, compatibility, and mutations |
| `contracts/settings.ts` | Setting definitions, values, scopes, provenance, revisions, validation, and mutations |
| `contracts/hooks.ts` | Hook events, matchers, handlers, decisions, trust, provenance, and execution receipts |
| `contracts/plugins.ts` | Plugin manifests, capabilities, activation events, contributions, leases, and health |
| `contracts/rpc.ts` | Versioned request, response, event, and protocol-error envelopes |
| `schemas/` | Runtime validators generated from or paired with canonical contract types |
| `runtime/` | Lifecycle state machine, registries, prompt pipeline, and execution scopes |
| `session/` | Store ports, projections, importer contracts, and compaction state machine |
| `settings/` | Registry, precedence, validation, optimistic concurrency, redacted projections, and change events |
| `models/` | Effective catalog merge, default validation, source adapters, and import/export contracts |
| `hooks/` | Codex parser/adapter, discovery, trust, command/MCP handlers, and output decisions |
| `plugins/` | Catalog, manifest validation, capability grants, transactional contributions, and activation |
| `adapters/` | Model, persistence, process, and transport-neutral adapter contracts |

Pi-specific translation code remains under `packages/octocode-pi-extension/src/`. No `pi-*` type, schema, or package import belongs in agent core.

## Type-design rules

1. Use discriminated unions for every runtime command, event, result, and externally visible error.
2. Parse `unknown` only at external boundaries. Internal handlers receive validated types.
3. Use branded string types for identities that must not mix: session, entry, branch, turn, tool call, request, and effect IDs.
4. Represent time as integer epoch milliseconds in runtime events and convert only in presentation code.
5. Represent cancellation with `AbortSignal` in process-local contracts and a typed cancellation event/error across process boundaries.
6. Keep immutable snapshots separate from command services.
7. Make required capabilities required. Use optional fields only for protocol evolution or semantically absent data.
8. Preserve opaque provider/Pi payloads only inside adapter-private types. Do not add an index signature to public contracts.
9. Define exhaustive error categories and retain an adapter-safe cause field that redaction can remove.
10. Keep presentation types out of tool/session/model domain contracts.

## Schema source of truth

TypeScript types and runtime schemas must stay mechanically consistent. Phase 1 selects one of these approaches and proves drift detection:

| Approach | Benefit | Risk | Acceptance condition |
|---|---|---|---|
| Schema-first with generated TypeScript | Runtime validation is canonical | Generated types can be less ergonomic | Generation is deterministic and checked in CI |
| Type-first with generated schemas | TypeScript authoring is ergonomic | Generators can lose refinements | Every public type produces an equivalent validator |
| Paired TypeBox schema and inferred type | Fits the existing tool-schema ecosystem | Manual wrappers can diverge | No duplicate handwritten interface for the same contract |

The implementation must choose one source of truth for each contract family. Handwritten schemas and handwritten types that describe the same wire shape are prohibited unless a compile-time and runtime equivalence test proves them identical.

## Runtime command types

The initial runtime command union covers:

| Command family | Required variants |
|---|---|
| Input | submit, steer, follow-up, cancel |
| Session | create, resume, switch, fork, navigate tree, name, export |
| Model | select model, set thinking level |
| Context | compact, cancel compaction, inspect usage |
| Tools | list, activate, execute through internal kernel only |
| Runtime | get snapshot, stop |

Every command envelope contains a protocol version, request ID, command discriminant, and typed payload. The in-process API can use direct method calls, but transport adapters must map them to the same command semantics.

## Runtime event types

The event union must cover every production-used Pi event and every event consumed by the Octocode shell or RPC client:

| Event family | Required semantic variants |
|---|---|
| Runtime | ready, stopping, stopped, failed |
| Session | starting, started, switching, forked, tree-changed, metadata-changed, stopping |
| Input | received, transformed, handled, queued, rejected |
| Agent | starting, started, settled, ended |
| Turn | started, ended |
| Message | started, delta, ended |
| Tool | requested, blocked, started, updated, ended |
| Model | selected, thinking-level-selected |
| Provider | request-started, response-received, failed |
| Context | usage-changed, compaction-started, compaction-retrying, compacted, compaction-failed |
| UI | interaction-requested, interaction-resolved, notification, status-changed, presentation-changed |

Each event type defines ordering, producer, blocking/transform authority, persistence visibility, transport visibility, and redaction class. `eventVersion` versions the payload independently of the RPC envelope version.

## Tool schemas and types

The canonical tool contract separates:

| Part | Contains | Excludes |
|---|---|---|
| Definition | name, label, description, input schema, output schema/version | Host renderer and execution state |
| Policy metadata | effect class, trust requirement, approval class, plan capability, lock target resolver | UI prompts |
| Executor | validated input, tool-call ID, execution context, abort signal, update sink | Host-specific context object |
| Update | versioned progress/details union | Arbitrary renderer component |
| Result | typed content, details schema/version, error flag/category | Provider/Pi raw result |
| Presentation | semantic call/result view model | Tool execution or policy decision |

Tool schemas must remain compatible with supported model providers. Provider-specific restrictions belong in schema compilation/validation tests, not in the domain type.

## Session schemas and types

Session storage uses a versioned envelope around an event union. Every stored event contains:

- schema version;
- session ID and event ID;
- monotonically increasing revision;
- event discriminant and validated payload;
- integer timestamp;
- optional parent/causation identifiers;
- visibility classification for model context, transcript, diagnostics, or internal projection;
- integrity metadata selected by the session RFC prototype.

The projection types cover session metadata, transcript, branch graph, selected leaf, compaction state, durable custom entries, and artifact references. Import-only Pi records are validated by the Pi importer/adapter and map into canonical session events or an explicitly typed opaque-import event.

## RPC schemas and types

The RPC contract uses four envelopes:

| Envelope | Required fields | Rule |
|---|---|---|
| Request | protocol version, request ID, command type, payload | Reject unknown major version before dispatch |
| Response | protocol version, request ID, success discriminator, data/error | Exactly one response per request that requires one |
| Event | protocol version, sequence, runtime event | Preserve order and event version |
| Protocol error | protocol version when parseable, request ID when parseable, error category, safe message | Never expose stack, secret, or raw provider payload |

Framing remains transport-specific. JSONL adapters validate one complete object per line and preserve correlated responses. The accepted Pi RPC fixtures remain compatibility inputs; Octocode's canonical contract does not import Pi RPC types.

## UI schemas and types

UI contracts describe semantics rather than terminal components:

| Contract | Examples |
|---|---|
| Interaction request | confirm, select, input, editor, custom capability fallback |
| Notification | message and severity |
| Status | named status slot and optional text |
| Presentation state | title, editor text, working state, header/footer/widget view models |
| Interaction result | accepted value, cancellation, timeout, unsupported capability |

The Pi extension maps these contracts to `ctx.ui` methods. The native terminal adapter maps the same contracts to `@opentui/core` as specified by `OPENTUI_TERMINAL_CORE.md`. Headless adapters return a typed unsupported/cancelled result according to policy rather than hanging. OpenTUI renderer, renderable, event, layout, color, key, and capability types cannot appear in these public contracts.

## Settings and model schemas

`SETTINGS_WEB_UI.md` uses canonical agent-core contracts rather than HTML form shapes or Pi settings objects.

| Contract | Required content |
|---|---|
| `SettingDefinition` | Stable key/version, section/order, value kind/schema, scopes, default, mutability, application timing, visibility/redaction, owner, and documentation |
| `SettingValue` | Validated value, stored/effective distinction, scope, source/provenance, revision, warnings, and application timing |
| `SettingsSnapshot` | Schema version, workspace/session identity, deterministic definitions/values, source health, and revision vector |
| `SettingsMutation` | Protocol version, request ID, action discriminant, scope, expected revision, and unknown payload parsed by the selected action schema |
| `SettingsMutationResult` | Success/error discriminator, stored/effective values, new revision, redacted impact, refresh/restart/new-session effect, and audit receipt ID |
| `ModelProviderDefinition` | Provider ID, API family, endpoint, credential/header references, defaults, compatibility, scope, source, and enabled state |
| `ModelDefinition` | Provider/model IDs, display metadata, limits, modalities, tool/thinking capabilities, cost metadata, compatibility, provenance, and warnings |
| `ModelCatalogSnapshot` | Version, deterministic effective providers/models, source contributions, default selection, refresh state, and revision vector |
| `ModelSourceDescriptor` | Stable source ID, kind, exact path when safe, owner, scope, precedence, writable/import-only state, hash/revision, parse state, and redaction class |

Setting value kinds use a discriminated union for boolean, enum, string, integer, duration, path, secret reference, structured object, and list. Model mutation variants cover default selection, provider/model upsert/removal, source replacement/import, and catalog refresh.

The source-of-truth schema must express cross-field rules such as provider/model identity, API-family compatibility, URL protocols, positive/nullable limits, capability combinations, cost units, and credential-reference exclusivity. Unknown limits, prices, and capabilities remain `null` or an explicit unknown state rather than sentinel numbers.

External settings/model payloads parse from `unknown`. Redacted projections use different types from stored secret-bearing records so a renderer cannot accidentally receive a secret value. Optimistic concurrency uses opaque branded revision/hash types. No HTML, DOM, browser, Pi, OpenTUI, filesystem, or raw credential type appears in these contracts.

## Hook and plugin schemas

`HOOKS_AND_PLUGINS.md` owns behavior. Agent core owns these runtime-validated shapes:

| Contract | Required content |
|---|---|
| `HookSourceDescriptor` | source ID, scope, path/provenance, managed/plugin identity, raw and normalized hashes, trust/review state, revision |
| `CodexHookConfiguration` | versioned event map, matcher groups, handler arrays, preserved unsupported definitions |
| `HookHandlerDefinition` | discriminated `command`, `mcp_tool`, and parsed-but-unsupported variants; timeout, status, async, output limit |
| `HookInvocation` | event identity, source/handler identity, validated common/event-specific input, deadline, abort signal |
| `HookDecision` | continue/stop, allow/deny/no-decision, supported rewrite, added context, suppression, safe diagnostic |
| `HookExecutionReceipt` | event/handler hashes, order, timing, exit/failure class, decision digest, spill/redaction counts |
| `PluginManifest` | identity/version, API compatibility, activation events, requested permissions, contained contribution paths |
| `PluginCapabilityGrant` | requested/granted/denied capabilities, scope, trust source, revision, expiry/review trigger |
| `PluginContribution` | discriminated hook/tool/command/resource/MCP/setting/prompt/UI/model contribution and owner identity |
| `PluginLifecycleEvent` | discovered, validated, trust-required, enabled, activating, contribution-registered/removed, ready, deactivating, stopped, failed |
| `PluginLease` | plugin/version/hash, contribution identity, active operation, cancellation, acquisition/release timestamps |
| `PluginHealthSnapshot` | compatibility, trust, enablement, activation state, contribution inventory, bounded recent failures |

Codex field aliases normalize at the parser boundary while retaining source provenance. Full-value MCP templates preserve JSON types. Canonical events and plugin lifecycle events are discriminated unions with exhaustive handling; no arbitrary event string can acquire blocking or mutation authority. Hook/plugin output parses from `unknown` and is revalidated after every transform.

Trust hashes, content hashes, revisions, event IDs, plugin IDs, and contribution IDs use distinct branded types. Public projections exclude raw commands, prompt text, arguments, environment values, secrets, and unbounded output. Settings receives redacted descriptors and typed mutation commands, never executable handler objects.

## Temporary Pi-oracle compatibility contract

`packages/octocode-pi-extension` is frozen and supported only during the bounded migration, comparison, and rollback window, subject to the following rules:

1. It imports public contracts and tool/runtime factories from agent core.
2. It owns all Pi SDK/extension type imports and host-shape translation.
3. It maps Pi lifecycle events into canonical agent-core events with documented field normalization.
4. It maps canonical tool, command, UI, session, and message operations back to Pi host APIs.
5. It never causes agent core to depend on Pi.
6. It runs the same semantic conformance suite as the native host plus Pi-specific adapter tests.
7. Its supported Pi-version matrix is explicit and tested.
8. An unsupported Pi version fails at activation with a typed compatibility error.
9. Pi-only presentation capabilities remain adapter extensions and cannot enter core domain contracts.
10. The final retirement gate deletes the Pi-extension package, selector, live compatibility matrix, publication path, and product documentation together.
11. Pi lifecycle inputs map to canonical hook events and canonical decisions map back without widening authority.
12. Hook/plugin contributions register through agent-core registries; Pi-specific presentation remains adapter-local until deletion.

## Pi-to-core mapping

| Pi surface | Agent-core contract | Compatibility check |
|---|---|---|
| `PiInstance.on` | `LifecycleBus` event registration/translation | Event family, order, transform/block behavior |
| `OctocodeHookComposer` | Canonical hook dispatcher behind the Pi event adapter | Stable middleware order, aggregation, errors, cancellation |
| `registerTool` | `ToolRegistry` definition adapter | Schema, name, updates, result, renderer view model |
| `registerCommand` | `CommandRegistry` adapter | Inventory, completion, command-context capabilities |
| `PiContext` | `ExecutionContext` plus explicit services | No privilege widening |
| `PiSessionManager` | Session identity/controller adapter | ID, file/import source, branch, leaf, command operations |
| `ctx.ui` | `UiPort` adapter | Dialog/status/widget/editor/headless behavior |
| Pi messages/entries | Transcript and session-entry ports | Model visibility and durability |
| Pi model/thinking methods | `ModelController` | Selection and failure semantics |
| Pi RPC envelopes | RPC compatibility adapter | Captured corpus and version behavior |

## Schema versions and compatibility

| Change | Version action | Compatibility requirement |
|---|---|---|
| Add optional event field with safe default | Minor event/schema version | Older consumers ignore it |
| Add union variant | Minor only when consumers already handle unknown variants; otherwise major | Exhaustiveness/unknown-variant tests |
| Rename/remove/change meaning | Major | Migrator or compatibility adapter |
| Storage projection-only change | No wire version; implementation version receipt | Replay remains deterministic |
| Session event shape change | New stored-event version and migrator | Old events remain readable |
| RPC framing or envelope change | Protocol major | Explicit negotiation or rejection |
| Pi mapping change | Adapter compatibility version | Pi-version matrix and conformance update |

Published schemas must expose a stable identifier and version. Tests must load every retained historical schema fixture and prove validation/migration behavior.

## Error types

The public error union includes at least:

- validation and protocol errors;
- unsupported version/capability errors;
- trust, approval, plan-policy, and peer-lock denials;
- cancellation and timeout;
- provider/model errors;
- tool execution errors;
- session conflict, corruption, migration, and persistence errors;
- compaction errors;
- adapter compatibility and translation errors;
- internal runtime invariant failures.

Every error defines whether retry is safe, whether it is user-visible, its redaction class, and its terminal-state effect.

## Schema and type validation

The mandatory test plan must verify:

- compile-time exhaustiveness for every discriminated union;
- runtime rejection of malformed and unknown-major-version payloads;
- schema/type drift detection;
- round-trip encode/decode for RPC and stored events;
- historical fixture validation and migration;
- Pi-to-core and core-to-Pi mapping for every supported adapter surface;
- provider-compatible tool schema compilation;
- secret redaction for every error/event visibility class;
- dependency direction: agent core has zero Pi/extension/launcher/UI imports;
- no duplicate canonical contract declarations outside agent core.
- every registered human-facing setting has a deterministic HTML rendering or an approved machine/secret-only classification;
- settings/model mutations reject stale revisions and malformed cross-field combinations;
- redacted settings/model projections cannot contain credential values by construction;
- canonical and legacy model-source fixtures preserve supported unknown fields and precedence during import/export.

Schema/type changes fail CI when they lack a version decision, fixture update, compatibility classification, and required migrator or adapter update.
