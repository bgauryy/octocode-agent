# Hooks, extensions, and event-driven plugins

> Decision owner: `RFC.md` §Package boundaries and §Event contract. Execution order: `STEPS.md`. Canonical schemas: `SCHEMAS_AND_TYPES.md`. Settings UI: `SETTINGS_WEB_UI.md`. Mandatory verification: `TEST_PLAN.md` and `KPI.md`.

## Decision

The native runtime supports lifecycle hooks and installable extensions/plugins through one versioned event and contribution system owned by `packages/octocode-agent-core/`. It accepts the Codex hook format as a compatibility input, including Codex event names, `hooks.json`, inline `[hooks]` configuration, command handlers, MCP-tool handlers, matchers, blocking decisions, asynchronous handlers, discovery, merge, and trust behavior. Octocode-native manifests can add broader typed contributions, but hooks and plugins cannot bypass policy, workspace trust, settings validation, or runtime ownership boundaries.

During the migration window, the frozen Pi oracle remains an adapter: Pi events enter the canonical bus and canonical decisions translate back to Pi results. Plugins target Octocode contracts, not Pi APIs. Host-only presentation contributions remain adapter-scoped, require a documented headless fallback, and disappear with the oracle at retirement.

## Current-state evidence

AST/text discovery and LSP checks on the 2026-08-27 working tree found:

| Surface | Evidence | Migration consequence |
|---|---|---|
| Central middleware | 17 `hooks.on(...)` registrations in `packages/octocode-pi-extension/src/index.ts` | Preserve stable ordering, transforms, blocking, errors, and cancellation. |
| Direct host listeners | 20 `pi.on(...)` occurrences across nine extension source files, including comments describing required wiring | Inventory real listeners separately from comments and route production listeners through canonical subscriptions. |
| Hook composer | `OctocodeHookComposer` and `createHookComposer` live in `hook-composer.ts` | Retain as a temporary Pi adapter or replace with the canonical dispatcher after conformance. |
| LSP use | `createHookComposer` has four references across `hook-composer.ts` and `index.ts`; the class is otherwise exported | The extraction blast radius is concentrated, but its public export requires a compatibility decision. |
| Commands | 18 central plus eight module registrations | Command contributions need duplicate detection, policy metadata, ownership, and deterministic unload. |
| Tools | 26 source files expose registration paths through one `registerTool` funnel | Plugin tool contributions must use the same canonical registry and security pipeline. |
| Existing event families | resource discovery; input; session start/shutdown/tree/compaction; agent/turn boundaries; tool call/execution; model/thinking selection | Map every used event to a canonical event and a Codex compatibility classification. |

Phase 0 reruns the checked-in Octocode queries and records exact counts against the named baseline commit. Text hits are candidates; LSP references and runtime traces prove production use.

### 2026-08-28 native implementation increment

The latest dirty-tree candidate advances this specification beyond the 2026-08-27 baseline:

- user and workspace hook discovery is contained, and default plugin discovery includes immediate `.codex/plugins` entries;
- review identity uses an exact normalized content hash, and changed or unreviewed code cannot execute;
- missing policy grants nothing; activation requires explicit capabilities;
- command hooks execute through the native lifecycle dispatcher and return blocking decisions;
- MCP hooks execute through the production registry-owned session manager, while asynchronous hook work is bounded, owned, drained, and cancelled on shutdown;
- eligible plugins activate transactionally, failed activation rolls back, contributions remain owner-scoped, and unload respects active leases;
- a real filesystem plugin fixture verifies discovery, activation, contribution ownership, unload, and cleanup;
- the protected settings page exposes revision-safe plugin review plus capability grant/revoke actions.

This is a production-composed partial implementation, not compatibility completion. Pinned Codex fixtures, formal capability-policy approval, the clean adversarial security matrix, and cross-host conformance remain release blockers. See [the integrated runtime closure receipt](evidence/integrated-runtime-closure-2026-08-28.md).

## Goals and non-goals

Goals:

- load Codex-compatible hooks without rewriting their configuration;
- expose stable Octocode lifecycle events independent of Pi, OpenTUI, and transports;
- allow trusted plugins to declare hooks and typed contributions;
- make activation, ordering, decisions, failures, and unload deterministic and observable;
- render all hook/plugin configuration, trust, health, and diagnostics in `settings.html`;
- preserve oracle comparison behavior through temporary event and decision adapters, then delete them at retirement.

Non-goals:

- claim that every future Codex handler type or plugin contribution is automatically supported;
- treat hook scripts as a complete security sandbox or enforcement boundary;
- let a plugin mutate internal registries directly or import private runtime implementation;
- execute project hooks before workspace trust is resolved;
- let an asynchronous hook approve, block, or rewrite an operation;
- hot-reload code in the middle of an active tool/model operation.

## Ownership and planned modules

| Planned module under `packages/octocode-agent-core/src/` | Responsibility |
|---|---|
| `events/contracts.ts` | Canonical event envelopes, phases, mutability, visibility, and result types |
| `events/bus.ts` | Ordered dispatch, cancellation, timeouts, aggregation, and trace receipts |
| `hooks/codex-schema.ts` | Codex-compatible configuration schemas and validation |
| `hooks/codex-adapter.ts` | Event, matcher, input, output, and decision translation |
| `hooks/discovery.ts` | Source discovery, merge, provenance, and trust eligibility |
| `hooks/command-handler.ts` | Bounded subprocess execution and structured I/O |
| `hooks/mcp-handler.ts` | Invocation through an already-connected canonical MCP port |
| `hooks/trust.ts` | Exact-definition hashes, review state, managed policy, and audit records |
| `plugins/manifest.ts` | Manifest schema, compatibility declarations, permissions, and contributions |
| `plugins/catalog.ts` | Discovery, validation, enablement, versions, and health |
| `plugins/activator.ts` | Transactional activation/deactivation and resource cleanup |
| `plugins/contributions.ts` | Typed contribution registry and duplicate/conflict rules |

Filesystem discovery, subprocess creation, MCP connections, HTML, OpenTUI, and Pi translation live behind ports or in consuming adapters. Agent core owns policy and schemas, not host implementations.

## Canonical event bus

Every event uses an immutable versioned envelope:

```ts
interface AgentEventEnvelope<TType extends AgentEventType, TPayload> {
  schemaVersion: 1;
  id: EventId;
  type: TType;
  phase: 'before' | 'permission' | 'after' | 'notification';
  sessionId: SessionId;
  turnId?: TurnId;
  parentEventId?: EventId;
  timestamp: string;
  cwd: string;
  mode: RuntimeMode;
  model?: ModelRef;
  trust: TrustSnapshot;
  payload: Readonly<TPayload>;
}
```

An event definition declares whether handlers may observe, add context, rewrite a supported payload, allow/deny, or stop continuation. The dispatcher sorts by managed policy, source scope, explicit priority, discovery order, and declaration order. Ties never depend on filesystem enumeration. A handler cannot emit the same intercepting event recursively unless that event explicitly allows recursion.

Decision events use one aggregator. Denial wins. Otherwise an explicit allow may bypass only the named approval prompt when the policy permits it. Rewrites compose in order and revalidate after every rewrite. Stop decisions terminate only the documented scope. Observation events cannot undo completed side effects.

## Codex hook format compatibility

The compatibility reader accepts Codex's three-level shape: event, matcher group, then one or more handlers. It supports `hooks.json` and inline `[hooks]` in TOML. JSON names and documented snake/camel aliases are normalized without losing source bytes or provenance.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(edit|write)$",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/check-write.sh",
            "timeout": 30,
            "statusMessage": "Checking write policy"
          }
        ]
      }
    ]
  }
}
```

Equivalent inline TOML is accepted from the `hooks` table:

```toml
[hooks]
PreToolUse = [
  { matcher = "^(edit|write)$", hooks = [
    { type = "command", command = "./scripts/check-write.sh", timeout = 30 }
  ] }
]
```

Supported Codex events:

| Codex event | Canonical phase | Match subject | Blocking/transform support |
|---|---|---|---|
| `PreToolUse` | before tool execution | canonical tool name | deny and supported input rewrite |
| `PermissionRequest` | permission decision | permission/tool kind | allow, deny, or no decision |
| `PostToolUse` | after tool result | canonical tool name | observe/context only; cannot undo side effects |
| `PreCompact` | before compaction | compaction reason | observe/context; any continuation control follows the pinned Codex event fixture |
| `PostCompact` | after compaction | compaction reason | observe/context only |
| `UserPromptSubmit` | before accepted input | input source | add context, stop, or supported text rewrite |
| `SubagentStart` | before worker activation | agent kind/name | stop when no worker has started |
| `SubagentStop` | worker terminal boundary | agent kind/name | observe/context and documented stop semantics |
| `Stop` | main agent terminal boundary | stop reason | documented continuation decision only |
| `SessionStart` | session activation | start reason | add context or fail activation |
| `SessionEnd` | session teardown | end reason | best-effort observation with strict timeout |

Codex `PreCompact` and `PostCompact` map to the existing Pi `session_before_compact` and `session_compact` adapter behavior. `UserPromptSubmit` maps to the existing input pipeline. Tool, session, subagent, and stop mappings are fixture-driven; any semantic gap is published in a compatibility report rather than silently approximated.

`prompt` and `agent` handler definitions are parsed and reported as unsupported/skipped until separately implemented. Unknown event or handler types are preserved for diagnostics but never executed. Compatibility has a version field and an automated fixture corpus so Codex changes cannot silently alter behavior.

## Discovery, merge, and trust

The default compatibility discovery set is:

- user `~/.codex/hooks.json` and hook definitions in `~/.codex/config.toml`;
- trusted project `.codex/hooks.json` and hook definitions in `.codex/config.toml`;
- enabled plugin hook files, defaulting to `hooks/hooks.json` or paths declared by `.codex-plugin/plugin.json`;
- Octocode user and project sources defined by the canonical settings registry;
- managed hook policy supplied by the installation administrator.

Matching definitions from every eligible source merge; a higher-level source does not replace the full event list. Every loaded definition records source, scope, content hash, parsed hash, managed state, trust state, plugin identity, and discovery order.

Project hooks require a trusted workspace. Non-managed hooks require review of the exact normalized definition hash. A changed definition returns to `review-required` and is skipped until accepted. Managed hooks are trusted only through managed policy; `allow_managed_hooks_only` disables non-managed definitions. Enablement is distinct from trust.

Plugin hook paths must be `./`-prefixed, resolve inside the plugin root after symlink resolution, and may be one path, multiple paths, inline objects, or arrays where compatibility requires. Plugin command environments expose `PLUGIN_ROOT` and `PLUGIN_DATA`; Codex compatibility may also expose `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. Values are scoped per invocation and never inherited across plugins.

## Handler execution

### Command handlers

Supported fields are `type`, `command`, `commandWindows`/`command_windows`, `timeout`, `statusMessage`, `additionalContextLimit`, and `async`. The executor:

- sends one JSON input document on stdin and closes stdin;
- uses an explicit working directory, minimal environment, bounded output, and process tree ownership;
- selects the platform-specific command deterministically;
- enforces cancellation and timeout, then terminates owned descendants;
- parses structured JSON output when present and classifies plain output as documented context/diagnostics;
- redacts secrets before logs, UI, session records, and receipts;
- spills large output to a protected temporary file with lifecycle cleanup and a safe summary;
- never runs through an interactive shell unless the manifest explicitly requests and policy allows it.

Most compatibility handlers default to the Codex-compatible timeout; `SessionEnd` uses its short compatibility timeout and cannot delay shutdown beyond the configured maximum. Exact defaults and upper bounds live in the schema rather than prose-only constants.

The initial pinned compatibility constants are:

| Constant | Codex-compatible value | Enforcement |
|---|---:|---|
| Default synchronous handler timeout | 600 seconds | Per-handler deadline and descendant cleanup |
| Default `SessionEnd` timeout | 1 second | Best-effort teardown |
| Maximum `SessionEnd` timeout | 3 seconds | Schema rejects a larger value |
| Maximum asynchronous handlers | 8 per session | Additional work queues or rejects with a typed limit result |
| Default large-output context threshold | Approximately 2,500 tokens | Configurable through `additionalContextLimit`; protected spill file plus safe summary |

### MCP-tool handlers

`mcp_tool` handlers declare `server`, `tool`, optional `input`, timeout, and status. `${field.nested}` templates resolve only against the validated hook input. A template occupying the complete value preserves the JSON type; interpolation inside a larger string produces a string. Missing paths fail explicitly.

Handlers use an already-connected MCP server through `McpToolPort`. They do not start or reconnect a server, recurse through hooks, or open an approval prompt. The result follows the same output validator and redaction path as command handlers.

### Common input and output

Codex-compatible stdin includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, and, for turn events, `turn_id`. `permission_mode` maps from the canonical policy snapshot to supported Codex values (`default`, `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions`). Event-specific fields are generated from validated canonical payloads.

Common output supports `continue`, `stopReason`, `systemMessage`, `suppressOutput`, and event-specific `hookSpecificOutput` only where the event contract permits them. Unknown fields are retained in diagnostics but cannot mutate runtime state. A successful process exit is not itself an allow decision.

Asynchronous handlers can observe and provide deferred diagnostics at the next safe delivery point. They cannot block, approve, rewrite, or mutate the already-dispatched event. The runtime caps concurrency per session, cancels outstanding work on session end, and attributes every result to its originating hook and event.

## Plugin manifest and contributions

An Octocode plugin uses `.codex-plugin/plugin.json` as the packaging entry point so a hook-bearing Codex plugin can be discovered without repackaging. The manifest has a versioned `octocode` extension block for capabilities beyond Codex hook packaging:

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "hooks": "./hooks/hooks.json",
  "octocode": {
    "apiVersion": "1",
    "activationEvents": ["onSessionStart", "onTool:example_search"],
    "permissions": ["events.observe", "tools.register"],
    "contributes": {
      "tools": ["./contributions/tools.json"],
      "commands": ["./contributions/commands.json"],
      "settings": ["./contributions/settings.json"]
    }
  }
}
```

Canonical contribution kinds are:

| Contribution | Registration boundary | Required controls |
|---|---|---|
| Hooks | Hook catalog/event bus | event capability, matcher, trust hash, timeout |
| Tools | `ToolRegistry` | schema, policy metadata, namespaced identity, executor capability |
| Commands | `CommandRegistry` | context capability, permission class, headless behavior |
| Skills/resources | Resource registry | contained paths, provenance, size and content limits |
| MCP servers/tools | MCP catalog/port | explicit process/network permissions and trust |
| Settings definitions | `SettingsRegistry` | schema, scope, redaction, owner, HTML renderer |
| Prompt fragments | Prompt pipeline | named placement, provenance, size, trust, snapshot review |
| UI presentations | semantic `UiPort` registry | no toolkit types, accessibility metadata, headless fallback |
| Model/provider adapters | Model registry | separately granted high-risk capability and secret boundary review |

Unknown contribution kinds fail validation for activation. Contributions are declarative where possible. Code activation receives a frozen capability object containing only granted operations.

## Activation event lifecycle

The plugin manager emits and records:

```text
PluginDiscovered -> PluginValidated -> PluginTrustRequired
  -> PluginEnabled -> PluginActivating
  -> ContributionRegistered* -> PluginReady
  -> PluginDeactivating -> ContributionRemoved* -> PluginStopped
```

Validation, trust denial, activation failure, timeout, duplicate identity, or cleanup failure emits `PluginFailed` with a typed phase and safe diagnostic. Activation is transactional: contributions become visible together only after validation succeeds; failure removes all contributions and owned resources in reverse order. Duplicate global identities fail unless the contribution kind defines explicit namespacing/override policy. There is no last-writer-wins registry mutation.

Activation events are allowlisted manifest strings, not arbitrary executable event expressions. Lazy activation is permitted only at safe boundaries. Disable, update, or reload waits for active leases or requests cancellation; it never swaps implementations during an effectful operation. Sessions record plugin id/version/content hash so resume can explain missing or changed behavior.

## Security and isolation

- Hook/plugin decisions run inside the canonical policy pipeline; they cannot lower managed policy or workspace trust.
- Permissions are deny-by-default and capability-scoped for process, filesystem, network, MCP, models, secrets, UI, and registry mutation.
- Path containment is checked after normalization and symlink resolution.
- Process handlers receive a minimal environment; protected configuration keys and credentials are never injected by default.
- Inputs and outputs have byte, depth, collection, time, and concurrency limits.
- The audit stream records definition hash, plugin identity, event, matcher, timing, decision, rewrite digest, failure class, and redaction count—not secret/raw prompt content.
- Hook output is untrusted input and is schema-validated before use.
- Tool hooks are defense-in-depth guardrails. Mandatory authorization remains in the runtime policy engine because some execution paths or future tools may not emit optional compatibility hooks.

## Settings HTML integration

`settings.html` adds Hooks and Plugins sections. They show discovered sources, provenance, exact review hash, managed status, enablement, event/handler type, matcher, permissions, contribution inventory, version/API compatibility, health, last execution, timing, and safe failures. Users can review, enable, disable, reorder only where policy permits, test with synthetic input, inspect a redacted trace, and deep-link via `#hooks` and `#plugins`.

The page never edits hook/plugin files as an unstructured text blob. Typed mutations use expected revisions. Unsupported definitions remain visible with a reason. Managed definitions are read-only. Trust approval displays the exact source and semantic diff; installing/enabling a plugin never silently trusts its hooks.

## Observability and measurement

Required counters and traces include discovery/validation outcomes, review-required definitions, activation duration, handler duration/timeout/cancellation, decisions by event, rewrites, output spill, redactions, async queue depth, contribution counts, duplicate conflicts, unload leaks, and compatibility gaps. Cardinality is bounded; raw command, prompt, arguments, and output are not metric labels.

Before/after receipts compare event order, decision result, transformed input, added context digest, process/MCP effects, contribution inventory, settings projection, and cleanup state. Each divergence names whether it is compatible, intentional improvement, unsupported, or a release blocker.

## Test strategy

Mandatory tests include:

- exact Codex JSON/TOML fixtures for every supported event, handler field, alias, matcher, merge source, and plugin hook form;
- canonical-to-Codex and Pi-to-canonical event mapping, including every production-used Pi event in the named baseline;
- precedence, stable ordering, deny-wins aggregation, rewrite revalidation, stop, and failure isolation;
- command stdin/stdout, exit, timeout, cancellation, descendant cleanup, environment, spill, truncation, and redaction;
- MCP template typing, missing paths, unavailable server, timeout, result validation, and no recursion/approval;
- workspace/definition/managed trust, changed hash, source containment, symlink, and malicious manifest cases;
- async concurrency, safe-point delivery, session cancellation, and prohibition on blocking decisions;
- plugin validation, permissions, lazy activation, transactional registration, duplicate conflicts, unload, update, resume provenance, and rollback;
- tool/command/settings/prompt/UI contribution registration through canonical registries;
- native, supported Pi-extension, print, JSON, RPC, and headless conformance;
- settings HTML completeness, review flow, semantic diff, accessibility, and secret scans.

## Migration and rollback

1. Freeze current Pi event/listener traces and Codex compatibility fixtures.
2. Add canonical event, hook, plugin, and contribution schemas to agent core.
3. Adapt the current `OctocodeHookComposer` and direct Pi listeners to the canonical bus.
4. Implement Codex discovery, validation, trust, command, and MCP handlers disabled by default.
5. Add plugin catalog, transactional contributions, settings sections, and diagnostics.
6. Run Pi/native shadow comparison only for pure event decisions; never duplicate handler effects.
7. Enable reviewed hooks/plugins for a canary cohort, then native default after gates pass.
8. Freeze Pi-specific hook composition as oracle-only behavior, then delete it with the Pi package after native conformance and rollback gates pass.

Before native default, rollback disables the new loader and selects the Pi adapter without rewriting hook/plugin files or trust records. After dependency removal, rollback uses the prior release artifact. A failed plugin is disabled independently; the runtime continues only if the failing event contract permits failure isolation.

## Acceptance criteria

- All supported Codex fixtures load with the documented discovery, merge, matcher, trust, input, and output semantics.
- Every production-used Pi listener in the named baseline has a canonical mapping and host-conformance trace.
- Plugins register only declared, validated, permission-granted contributions through canonical registries.
- Activation/unload is deterministic, transactional, leak-free, and auditable.
- `settings.html` completely exposes hook/plugin configuration, provenance, review, health, and compatibility.
- Native and supported Pi-extension behavior passes the same hook/plugin suite.
- No hook or plugin bypasses runtime policy, leaks a secret, duplicates an effect, or leaves an owned process/resource.

## Official Codex evidence

The compatibility target is the official Codex hooks documentation checked on 2026-08-27: `https://learn.chatgpt.com/docs/hooks`. It defines lifecycle events, `hooks.json` and TOML discovery, merged sources, matchers, command and MCP handlers, common input/output, async limitations, plugin hook packaging, definition-hash trust, managed policy, timeouts, output handling, and the guardrail limitation. The implementation phase stores a dated schema fixture and change-review receipt rather than relying on this prose remaining current.
