# Design 04: Native TUI and unified settings

> Status: required target design; current implementation is incomplete. Owners: native launcher/TUI, agent-core settings, Pi compatibility adapter, security, and release verification. Normative sources: [`OPENTUI_TERMINAL_CORE.md`](pi-coding-agent-removal/OPENTUI_TERMINAL_CORE.md), [`SETTINGS_WEB_UI.md`](pi-coding-agent-removal/SETTINGS_WEB_UI.md), [`HOOKS_AND_PLUGINS.md`](pi-coding-agent-removal/HOOKS_AND_PLUGINS.md), [`SCHEMAS_AND_TYPES.md`](pi-coding-agent-removal/SCHEMAS_AND_TYPES.md), and [`TEST_PLAN.md`](pi-coding-agent-removal/TEST_PLAN.md).

## Purpose

This document defines the product boundary and completion gates for two connected user-facing systems:

1. the native interactive terminal built on `@opentui/core`; and
2. the single settings control center shared semantically by native `octocode-agent` and the supported Pi extension.

The native terminal is an adapter over agent-core semantics. The settings page is an adapter over canonical settings, model, hook, and plugin services. Neither adapter owns runtime policy, trust decisions, persistence state machines, or duplicate domain contracts.

## Current-state assessment

The working tree proves useful seams, but not the RFC acceptance state.

### Native terminal gaps

- `packages/octocode-agent/src/terminal/opentui/renderer.ts` creates one `TextRenderable`; it has no editor, confirm, select, input, focus, keymap, mouse, resize, or capability implementation.
- `createOpenTuiUiPort` defaults every interaction to `unsupported` and has no production composition caller.
- `runInteractive` reads lines through Node `readline`, independently of the OpenTUI renderer. It therefore cannot provide canonical focus, editing, steering, follow-up, or cancellation behavior.
- Presentation projection covers text deltas, notifications, named statuses, and coarse runtime state only. It omits thinking, tool preparation/progress/result/error, approvals, interaction requests, and structured widgets. The renderer ignores editor, widget, ready, and working fields.
- Renderer creation and runtime subscription occur outside the full cleanup boundary. Runtime shutdown failure can skip terminal destruction. There is no explicit signal integration or typed initialization failure.
- Every delta renders synchronously and appends to an unbounded transcript. There is no presentation-only coalescing or render backpressure.
- Print, JSON, and RPC avoid constructing a terminal, but the launcher statically imports the OpenTUI renderer. Headless dependency isolation and native-library loading purity are not proven.
- Existing tests use a hand-written renderer facade. They do not exercise `@opentui/core/testing`, a real PTY, input, mouse, focus, resize, terminal capabilities, Unicode width, narrow terminals, crashes, or platform restoration.

### Settings gaps

- Native `renderSettingsHtml` is a static, production-unused page. The native command surface has no `/settings` equivalent, browser server, URL result, or deep-link composition.
- Native configuration reads and writes `FileSettingsStorage` directly. It does not use the canonical `SettingsRegistry` and `SettingsService`, and raw `config list` projections can expose legacy secret-shaped values.
- Native default-model writes accept any nonempty `provider/model` pair without resolving the effective catalog.
- The Pi page registers only footer density, permission level, and a read-only active-model projection.
- The Pi Models section reports active identity and source-file presence, not the required catalog, provenance, CRUD, import, diff, conflict, or rollback workflows.
- The Pi Hooks section offers exact-hash review and enablement but lacks complete event/handler summaries, permissions, synthetic validation, execution health, and bounded diagnostics.
- The Pi Plugins section is a count and compatibility note, not a plugin inventory or lifecycle manager.
- Expected revisions are optional on several browser actions; MCP and skill actions do not share the canonical settings mutation envelope.
- The live Pi settings document has origin and token protection at the server but lacks the required restrictive CSP.
- Native and Pi do not yet run one settings conformance suite or expose identical canonical effective values.

These gaps keep the native-default, platform, security, canary, and removal gates on hold.

## Architectural boundaries

```text
agent-core semantic contracts and services
  RuntimeEvent / UiPort / SettingsService / ModelCatalog
  HookCatalog / PluginManager / typed mutations and receipts
           ^                              ^
           |                              |
native octocode-agent adapters       supported Pi adapters
  OpenTUI + native browser host        Pi UiPort + /settings opener
  filesystem/model source ports        Pi host/model source ports
```

### Agent core owns

- canonical UI commands, interaction requests/results, presentation events, and typed failures;
- immutable presentation reduction inputs, never toolkit objects;
- settings definitions, precedence, validation, revisions, mutation results, and redacted projections;
- effective model catalog and model-source transactions;
- hook/plugin catalogs, trust state, permissions, health, and lifecycle mutations;
- application timing and invalidation events.

### Native adapters own

- OpenTUI renderer creation, terminal enter/restore, capability detection, input, focus, layout, and destruction;
- semantic presentation-state to renderable-tree projection;
- browser opening and loopback settings-server composition;
- native filesystem and model-source ports.

### Pi adapters own

- mapping canonical UI semantics to supported Pi host APIs;
- Pi host model/source projections and explicitly classified host-only settings;
- `/settings` and compatible section aliases;
- typed unsupported results where the Pi host cannot provide transactional behavior.

No OpenTUI type may cross the native terminal directory. No HTML, browser, filesystem, Pi, or OpenTUI implementation may enter agent core.

## Native OpenTUI target design

### Composition and headless isolation

Mode selection happens before importing or constructing the terminal adapter.

- Interactive mode dynamically imports the OpenTUI composition module, creates one renderer, and owns it for the session.
- Print, JSON, RPC, and other headless modes do not import `@opentui/core`, resolve its native optional packages, change TTY modes, install terminal handlers, or write terminal control bytes.
- Headless stdout remains protocol-only: text for print, JSON for JSON mode, and JSONL for RPC. Diagnostics use stderr under the mode contract.
- The accepted runtime route pins the exact supported runtime, flags, OpenTUI version, native artifact set, and platform matrix. A broad engine range is not a substitute for that receipt.

### Renderer lifecycle

The adapter implements an explicit lifecycle:

```text
new -> initializing -> ready -> stopping -> stopped
                    \-> failed -> stopping -> stopped
```

Rules:

1. `start()` is idempotent only after reaching `ready`; concurrent starts share one initialization promise.
2. Every resource acquired during initialization is pushed onto a cleanup stack immediately. Failure after terminal entry, renderer creation, view creation, handler registration, or first frame unwinds the stack in reverse.
3. Initialization failure returns a typed terminal error with stage and redacted diagnostic.
4. `stop()` is idempotent and always attempts every cleanup action, aggregating failures without skipping terminal restoration.
5. Normal exit, runtime error, cancellation, EOF, Ctrl-C, SIGTERM, resize failure, render failure, and uncaught interactive-loop failure enter the same stop path.
6. Signal handlers are installed only for the owned interactive session and removed during cleanup. Repeated signals escalate according to a documented policy without double-destroy.
7. Runtime subscription is established inside the cleanup boundary. Renderer callbacks enqueue semantic commands; they never synchronously re-enter runtime mutation.
8. The renderer is destroyed exactly once, raw mode is disabled, cursor and alternate-screen state are restored, mouse/paste modes are reset, and owned listeners/timers are removed.

### Presentation model

The pure reducer projects canonical events into immutable state containing:

- runtime readiness and working/cancelling/failed/idle state;
- transcript messages and streaming text/thinking segments;
- tool prepared input, progress, result, classified failure, and cancellation;
- approval/policy/peer-lock states;
- named statuses and bounded notifications;
- title, editor buffer, header, footer, widgets, focus target, layout state, and terminal capabilities;
- active interaction and typed validation/cancellation/timeout state.

Structured values are validated and copied into owned immutable view models. Rendering never stringifies arbitrary objects and never mutates domain events.

Presentation-only updates may coalesce to an animation-frame or measured cadence. Interaction requests, approvals, runtime terminal events, tool results, and cancellation boundaries are never dropped. Transcript and notification retention are bounded or virtualized so sustained streaming does not redraw an ever-growing string.

### Views and interaction

The native adapter implements every canonical interaction:

| Request | Required behavior                                                                             |
| ------- | --------------------------------------------------------------------------------------------- |
| Confirm | Visible question, affirmative/negative focus, Enter, explicit cancel, timeout, mouse parity   |
| Select  | Keyboard navigation, type/search where approved, mouse selection, resize preservation, cancel |
| Input   | Editable buffer, cursor movement, validation, submit, cancel, paste handling                  |
| Editor  | Multiline editing, scrolling, submit/cancel keymap, initial value, resize preservation        |
| Custom  | Registered capability renderer or typed `unsupported`; never a silent hang                    |

The keymap has one documented source of truth. Focus order is deterministic and visible. Ctrl-C first cancels the active interaction/turn according to runtime state; a later escalation stops the session. Steer and follow-up input are routed as distinct semantic commands while a turn is streaming.

Mouse support mirrors keyboard operations but is never required to complete a flow. Resize preserves the active buffer, selection, focus, scroll position where possible, and semantic state. Minimum-size behavior renders a stable reduced view or typed unsupported state rather than corrupting frames.

### Terminal capabilities and accessibility

Capability detection covers color depth, Unicode width, mouse, bracketed paste, hyperlinks/clipboard when approved, dimensions, and alternate-output support. Unsupported capabilities produce typed adapter behavior, not guessed control sequences.

Acceptance requires:

- complete keyboard-only operation;
- deterministic focus order and visible focus;
- color-independent severity labels and status glyphs;
- Unicode/grapheme-width correctness;
- reduced-motion behavior for any animation;
- narrow-terminal and resize recovery;
- an approved screen-reader or alternate-output strategy;
- no critical information conveyed only by position, color, or animation.

## Unified settings target design

### One service, multiple hosts

There is one canonical registry and service composition for native and Pi hosts. Each setting registers once with stable key/version, section/order, value kind, scopes, default, stored/effective value, provenance, mutability, application timing, redaction class, owner, validator, normalizer, and documentation.

Host adapters contribute storage and capability ports, not competing definitions. Host-only settings are explicitly classified with a reason. A test fails when a human-facing registered setting has no HTML renderer or approved machine/secret-only classification.

The native CLI `config get/set/list`, model selection, browser page, automation, and Pi page all call the same service. Public projections are redacted by construction; raw storage records are never handed directly to CLI, HTML, logs, errors, diffs, or receipts.

### Page composition and navigation

`settings.html` is the only human-facing settings center. Native and Pi compose the same section renderers and typed client protocol.

- `/settings` opens Overview.
- `/settings models`, `/settings hooks`, and `/settings plugins` open the matching anchors.
- Compatibility aliases such as `/mcp` retain focused links during the approved migration window.
- Interactive mode opens the browser; noninteractive modes return a typed URL/event according to their protocol contract and never print incidental prose into structured stdout.

Every page includes Overview, Runtime, Appearance, Models, Hooks, Plugins, Commands, Connections, Add server, Discovery, Agent context, Skills, Overrides, and Diagnostics. Layout is responsive, landmarks/headings are semantic, every control is labeled, errors are announced, focus survives reload/conflict flows, and all operations are keyboard accessible.

### Models panel

The Models panel provides:

- searchable effective providers/models with source, scope, precedence, availability, default state, authentication readiness, redacted endpoint, limits, modalities, tools/thinking capability, cost metadata, compatibility, and application timing;
- atomic default provider/model selection validated against the effective catalog;
- structured provider/model create, update, enable, disable, and delete flows;
- environment or credential references only, never raw secret entry in the normal form;
- canonical and legacy `models.json` sources with path, owner, scope, revision/hash, parse state, writability, precedence, and contribution;
- redacted advanced JSON, full-schema validation, semantic diff, dependency impact, expected revision, atomic write, permission preservation, backup, recovery, import-only legacy behavior, and frozen-session warnings.

Unknown metadata remains unknown. Destructive provider/model changes require dependency checks, impact preview, and explicit confirmation.

### Hooks panel

Each hook source displays scope/provenance, managed state, raw and normalized hashes, trust and enablement separately, events, matchers, handler types, compatibility, requested/granted authority, last safe result, bounded timing/failure health, and unsupported definitions with reasons.

Typed actions support exact-hash review, enable/disable, capability decision, safe reload, and synthetic validation. Synthetic tests cannot call production model providers, effectful tools, arbitrary production MCP endpoints, or expose raw commands/environment/payloads. A changed hash invalidates review. Managed sources are visible and read-only. Workspace actions fail closed unless current trust is positively verified.

### Plugins panel

Each plugin displays identity, version, API compatibility, activation events, exact source/hash, trust, requested/granted/denied permissions, contributions, leases, lifecycle state, update availability, and bounded health.

Typed actions support review, enable, disable, activate, unload, update, and synthetic validation. Activation is transactional: contributions become visible together or are removed in reverse on failure. Unload waits, cancels, or refuses around active leases under canonical policy. Unsupported Pi contribution kinds fail closed and clearly state the required reload boundary.

### Protected mutation protocol

All mutations use the canonical versioned envelope with a required request ID and expected revision. The server parses `unknown`, resolves the action schema, checks authorization and policy, computes a redacted preview, commits through the owning service, refreshes affected projections, and returns a typed redacted result and audit receipt.

Protections include:

- loopback binding plus exact host allowlist to resist DNS rebinding;
- POST-only JSON actions, exact origin, per-generated-page action token, body and collection limits;
- restrictive CSP with no remote script or style execution, no third-party requests, `no-store`, `nosniff`, and referrer suppression;
- lexical and realpath containment, symlink rejection, approved URL protocols, and endpoint warnings;
- positive workspace trust before workspace writes or imported-source access;
- environment/header-name validation and secret-reference-only normal forms;
- no secrets in HTML, DOM attributes, JavaScript state, URLs, responses, errors, logs, diffs, backups, or receipts;
- explicit confirmation and redacted impact for destructive mutations;
- narrow audit receipts containing setting/action key, scope, revisions, outcome, and redacted impact only.

Opening a page never grants trust. Browser authorization never bypasses plan, approval, managed policy, peer locks, or contribution permissions.

### Concurrency, conflicts, and rollback

Every mutable source has an optimistic revision or hash. The mutation checks the revision again at the commit boundary. Concurrent tabs, external edits, or catalog changes return a typed conflict containing only safe current metadata and offer Reload and Compare; the service never silently applies last-write-wins.

Multi-file or catalog-affecting operations stage and validate the full effective result before commit. Writes use a temporary sibling, safe permissions, file and directory durability as supported, atomic rename, and recoverable backup. Failure leaves the prior effective snapshot valid and removes owned temporary files.

Rollback is explicit:

- a failed mutation automatically restores the prior effective state without rewriting read-only imports;
- a user recovery action selects a known backup/revision and produces a new receipt;
- before native-default, release rollback selects the Pi-backed host without mutating settings sources;
- after native dependency removal, release rollback uses the prior artifact;
- rollback never silently overwrites a newer external edit.

## Test design

### Native TUI tests

1. Pure reducer tests cover every UI/runtime event, immutable structured state, redaction, status replacement/clear, bounded retention, and coalescing rules.
2. `@opentui/core/testing` covers golden frames plus semantic assertions for input, editor, confirm, select, custom unsupported behavior, keyboard, mouse, focus, resize, clock, capabilities, Unicode, narrow terminals, and exactly-once destruction.
3. Fault injection covers failure before terminal entry, after entry, during view creation, first frame, render, interaction, runtime subscription, runtime stop, and cleanup.
4. Real PTY tests cover normal exit, EOF, Ctrl-C, repeated Ctrl-C, SIGTERM, crash, resize, paste, Unicode, minimum dimensions, and terminal restoration.
5. Headless tests prove OpenTUI is neither imported nor initialized and verify byte-pure stdout/stderr for print, JSON, and RPC.
6. Platform receipts cover every supported OS, architecture, runtime route, libc/native artifact variant, and packaged launcher.
7. Accessibility checks cover keyboard-only completion, focus visibility/order, color independence, reduced motion, and the approved alternate-output strategy.

### Settings tests

1. Registry snapshots cover every definition field and fail unrendered human-facing settings.
2. Native/Pi conformance runs the same snapshot and mutation corpus and classifies host-only differences.
3. Models tests cover catalog merge/precedence, validated default transaction, CRUD, legacy import, unknown fields, semantic diff, dependency checks, refresh, conflict, backup, rollback, and frozen-session warning.
4. Hooks/plugins tests cover trust/hash invalidation, permissions, enablement, synthetic validation, transactional activation/unload/update, leases, managed policy, unsupported definitions, and redacted health.
5. Browser tests cover all sections/deep links, keyboard operation, responsive layout, focus/error announcements, CSP, origin/token/CSRF/DNS-rebinding defenses, cache policy, and malformed actions.
6. Storage fault tests cover stale revisions, concurrent tabs, external edits, temporary write, fsync/rename, permissions, traversal, symlink, recovery, restart replay, and no partial effective state.
7. Secret-marker scans cover generated HTML, DOM, client state, action requests/responses, URLs, logs, errors, diffs, backups, receipts, and CLI output.
8. End-to-end tests cover native and Pi `/settings`, section openers, save/reload/compare/import/recover, typed noninteractive URL behavior, and real packaged artifacts.

## Acceptance criteria

The TUI/settings design is complete only when all of the following have signed receipts:

- Every canonical UI interaction works natively or returns an approved typed unsupported result for a genuinely optional capability.
- Renderer initialization and destruction are exactly once, terminal restoration passes every exit/fault/signal path, and no owned listeners, timers, children, or terminal modes leak.
- Streaming, tool progress, approvals, presentation commands, steer/follow-up, cancellation, focus, mouse, resize, Unicode, narrow terminals, and accessibility gates pass.
- Print, JSON, RPC, and headless paths do not import or initialize OpenTUI and preserve protocol-pure stdout/stderr.
- `/settings` is the sole human-facing settings center and native/Pi hosts expose the same canonical effective settings and typed mutations.
- Models, Hooks, and Plugins panels implement their full inventory, provenance, trust, health, mutation, conflict, and rollback contracts.
- All workspace mutations fail closed without verified trust; all browser actions pass CSP, origin, token, containment, revision, and policy checks.
- Raw secrets are absent from every browser, CLI, protocol, diagnostic, diff, backup, log, and receipt surface.
- Concurrent changes never silently overwrite one another, failed transactions preserve the prior effective snapshot, and rollback has been executed against the candidate artifact.
- `@opentui/core` runtime/version/platform requirements and the full real-PTY/platform matrix pass on the packaged candidate.

Until every criterion is evidenced, native-default and Pi-removal release gates remain **HOLD**.
