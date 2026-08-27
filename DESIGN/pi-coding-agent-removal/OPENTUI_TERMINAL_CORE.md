# OpenTUI terminal core

> Decision owner: `RFC.md` §Package boundaries. Execution order: `STEPS.md`. Semantic contracts: `SCHEMAS_AND_TYPES.md` §UI schemas and types. Appearance/settings surface: `SETTINGS_WEB_UI.md`. Acceptance: `TEST_PLAN.md` and `KPI.md`.

## Decision

The RFC proposes `@opentui/core` as the native `octocode-agent` terminal rendering and input foundation. The route remains **HOLD** pending runtime/architecture-owner approval and the Step 2 runtime, packaging, platform, security, and rollback spike. An approved first implementation uses OpenTUI Core directly. React and Solid renderers remain excluded unless a later measured proposal proves that an additional framework improves maintainability without weakening startup, packaging, or test gates.

OpenTUI is a terminal adapter, not part of the agent runtime kernel. The planned `packages/octocode-agent-core/` package owns semantic `UiPort` contracts and remains terminal-toolkit-neutral. The native adapter lives under the planned `packages/octocode-agent/src/terminal/opentui/` boundary and is the only native product layer allowed to import `@opentui/core`.

The supported `@octocodeai/pi-extension` continues to map the same `UiPort` semantics to Pi host UI APIs. It does not import OpenTUI.

## Why OpenTUI

The official project describes OpenTUI as a TypeScript terminal UI library backed by a native Zig core, with Flexbox layout, keyboard and mouse input, selects, inputs, and scroll boxes. Its public packages separate the core renderer from optional React and Solid bindings. The core package also exports `@opentui/core/testing`, which supplies an in-memory renderer and input, mouse, clock, capability, spy, and frame-recording helpers.

This matches the migration requirements:

- a terminal implementation independent of Pi;
- a semantic adapter boundary instead of terminal components leaking into runtime contracts;
- deterministic rendering and input tests without writing to the developer's terminal;
- explicit renderer ownership and destruction;
- support for interactive layout, input, selection, scrolling, keyboard, mouse, and terminal capabilities.

## Working-tree prototype evidence

The 2026-08-27 proof at commit `3188378` found that the three prototype files previously cited here were absent from the working tree and from the visible Git history. Octocode file, text, structural AST, and LSP workspace-symbol queries found no OpenTUI repository seam, and the named focused test command exited 1 because no matching test file existed. The isolated `@opentui/core@0.5.8` Bun and Node test-renderer smokes therefore establish local runtime feasibility only; they do not establish a repository adapter, production composition, packaging, PTY lifecycle, or platform support. See [the working-tree route proof](evidence/opentui-route-working-tree.md) and [the route decision packet](evidence/opentui-route-decision-packet.md).

Implementation must create a canonical test seam under the planned native adapter boundary and derive host-neutral snapshot semantics from the approved `UiPort` contract. It must not invent provenance for the absent proof, leave duplicate `OpenTui*` domain contracts in the supported Pi extension, or make that extension the owner of the native terminal.

## Runtime and packaging gate

OpenTUI's current official support matrix requires one accepted route:

| Route | Current upstream requirement | RFC gate |
|---|---|---|
| Bun | Bun 1.3.0 or later | Prove workspace build, packaged launcher, native artifact resolution, startup, and all supported platforms. |
| Node.js ESM | Node.js 26.4.0 exactly with `--experimental-ffi` under the current upstream acceptance statement | Prove the repository can adopt the exact runtime and flag without breaking CLI, MCP, skills, subprocesses, packaging, or upgrades; recheck upstream before approval. |

Before Stage 1 exits, a spike must select and document one route. The spike records exact runtime versions, flags, package-manager behavior, native optional-package resolution, macOS/Linux/Windows architecture coverage, libc coverage where applicable, packaged artifact behavior, startup latency, peak RSS, and terminal restoration.

Failure to prove either supported route blocks the native terminal stage. It does not authorize a hidden `pi-tui` fallback or moving OpenTUI into agent core.

## Planned boundary

```text
packages/octocode-agent-core
  UiPort + UiCommand + UiEvent + InteractionResult
                    ^
                    |
packages/octocode-agent/src/terminal/opentui
  UiPort adapter + renderer lifecycle + keymap + views
                    |
              @opentui/core
```

The adapter owns:

- `createCliRenderer()` and exactly-once renderer destruction;
- terminal enter/restore behavior and signal integration;
- semantic view-model to renderable-tree projection;
- focus, keyboard, keymap, mouse, resize, clipboard-capability, and accessibility behavior;
- editor, input, select, confirm, notifications, status, working state, transcript, tool progress, header, footer, and widgets;
- capability detection and typed unsupported behavior;
- frame normalization for tests.

The adapter must not own:

- tool policy, trust, approval, plan, or peer-lock decisions;
- model, session, compaction, or lifecycle state machines;
- canonical command/event schemas;
- Pi compatibility translation;
- direct mutation of runtime state outside `UiPort` commands.

## Mapping contract

| Agent-core semantic contract | OpenTUI responsibility | Required proof |
|---|---|---|
| Interaction request | Render confirm, select, input, or editor and return one typed result | Keyboard, mouse, cancel, timeout, resize, and unsupported tests |
| Notification | Render severity and message without blocking runtime progress | Golden frame plus headless semantic event |
| Named status | Update or clear one stable status slot | Replacement/clear ordering tests |
| Working state | Show active, cancelling, failed, or idle state | Runtime trace and frame synchronization |
| Transcript event | Project messages and streaming deltas without mutating domain events | Stream/update golden frames |
| Tool presentation | Render prepared input, progress, result, and classified error | Long output, Unicode, redaction, and cancellation tests |
| Presentation state | Apply title, editor content, header, footer, widget, focus, and layout | Resize and minimum-terminal-size matrix |

No OpenTUI class, renderable, event, color, layout, key, or renderer type may appear in an agent-core public contract.

## Lifecycle and failure rules

1. The composition root creates one renderer per interactive terminal session.
2. Startup either reaches ready or returns a typed terminal-initialization error.
3. Shutdown is idempotent and restores the terminal after normal exit, error, cancellation, signal, and failed initialization.
4. Renderer callbacks enqueue semantic commands; they do not re-enter mutable runtime handlers synchronously.
5. Runtime events are reduced into immutable presentation state before rendering.
6. Slow frames may coalesce presentation-only updates but never drop terminal runtime, interaction, approval, or tool-result semantics.
7. Rendering errors cannot corrupt the session store or leave a tool effect unclassified.
8. Noninteractive modes never initialize OpenTUI and preserve stdout/stderr protocol purity.

## Test strategy

Use three layers:

| Layer | Mechanism | Required coverage |
|---|---|---|
| Projection unit tests | Pure semantic state reducer | Every UI command/event, exhaustive state transitions, redaction |
| Renderer integration | `@opentui/core/testing` | Frames, input, mouse, resize, focus, clocks, capability variants, destruction |
| Real-terminal E2E | PTY on every supported platform/runtime route | Signals, Ctrl-C, crash, resize, Unicode, narrow terminal, restoration, stdout/stderr isolation |

Golden frames normalize timestamps, dimensions, colors, cursor state, and nondeterministic identifiers. Semantic assertions remain authoritative; snapshots cannot be the only proof.

## Performance and accessibility gates

Record cold and warm renderer startup, time to first frame, p50/p95 frame duration, peak RSS, sustained streaming behavior, resize recovery, and shutdown time. `KPI.md` owns final thresholds from the canonical before baseline.

Keyboard-only operation is mandatory. Focus order, visible focus, cancellation, color-independent severity, reduced-motion behavior where animation exists, Unicode width, screen-reader/alternate-output strategy, and minimum terminal dimensions require explicit acceptance decisions before native becomes default.

## Rollback

Before the native-default gate, rollback selects the Pi-backed host for new native-agent sessions. After removal, rollback uses the prior release artifact. The native terminal never silently switches to `pi-tui`; the separately supported Pi extension remains available only in a Pi host.

## Upstream evidence checked on 2026-08-27

- [OpenTUI repository README](https://github.com/anomalyco/opentui/blob/main/README.md) — architecture, packages, TypeScript/Core/React/Solid split, and production use claim.
- [OpenTUI runtime and platform support](https://opentui.com/docs/getting-started/runtime-support) — Bun and Node.js runtime requirements and native asset behavior.
- [OpenTUI package entry points](https://opentui.com/docs/reference/package-entrypoints) — supported Core and testing imports.
- [OpenTUI testing documentation](https://opentui.com/docs/core-concepts/testing) — in-memory renderer and deterministic test facilities.
- [`@opentui/core` package](https://www.npmjs.com/package/@opentui/core) — package identity and published version line.

The implementation receipt must pin the exact accepted OpenTUI version and recheck these requirements; this RFC does not treat the inspected `0.5.8` API as permanently stable.
