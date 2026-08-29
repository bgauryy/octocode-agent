# TUI and settings implementation guide

Status: production-composed candidate; release remains `HOLD`.

This page routes implementation work. The normative terminal contract is [OpenTUI terminal core](pi-coding-agent-removal/OPENTUI_TERMINAL_CORE.md), the widget contract is [OpenTUI widgets and accessibility](11-OPENTUI-WIDGETS-AND-ACCESSIBILITY.md), and the settings contract is [settings web UI](pi-coding-agent-removal/SETTINGS_WEB_UI.md).

## Composition boundaries

The launcher chooses the immutable mode before constructing terminal resources. Interactive mode owns the OpenTUI renderer and single input reader. Print, JSON, and RPC modes never initialize the terminal. All modes consume the same semantic runtime events; output adapters decide only how to project them.

Settings use one registry and service for validation, revision control, redaction, and atomic persistence. The terminal `/settings [section]` command opens the protected loopback page. Neither the page nor a CLI command may parse or write configuration independently.

```text
runtime events ─▶ semantic reducer ─▶ widget controller ─▶ OpenTUI renderer
                       │
                       ├─▶ accessible text projection
                       ├─▶ JSON/RPC public projection
                       └─▶ transcript/session projection

CLI and browser actions ─▶ SettingsService ─▶ validated atomic storage
                                     └──────▶ next-session runtime projection
```

## Current verified slice

- Dedicated widgets cover messages, thinking, tool calls, Skills, plan, ask, progress/tasks, input, footer, diagnostics, and errors.
- The reducer owns state; widgets render typed view models and do not read storage directly.
- Ask, plan, progress, and task updates share semantic events with headless modes.
- The settings server is loopback-only, validates host/origin/action token/body size, uses realpath containment, disables caching, and redacts secrets.
- Theme and default-model writes use revision-safe atomic persistence and preserve unknown storage.
- Browser checks cover a real save, focus and ARIA behavior, Anthropic/provider visibility, and a 390-by-844 viewport without horizontal overflow.
- A real pseudo-terminal smoke test restored terminal state exactly on the tested macOS/Node 26 host when experimental FFI was enabled.

## Required invariants

1. One owner reads terminal input.
2. Rendering is a pure projection of typed state; widgets do not mutate sessions, plans, tools, or settings.
3. Every interactive action has a keyboard route and an accessible text representation.
4. Output adapters never expose system prompts, repository instructions, secrets, or private internal events.
5. Settings mutations are allowlisted, revision-checked, validated, atomic, and auditable.
6. Closing, cancellation, suspend, crash, and signal paths restore the terminal exactly once.
7. Unsupported platform or FFI combinations fail clearly before corrupting terminal state.

## Release work

| Workstream | Required evidence |
| --- | --- |
| Terminal packaging | Clean install and packed-artifact run with the approved OpenTUI/native dependency route |
| Platform support | PTY and restoration matrix on every supported platform and Node version |
| Accessibility | Keyboard-only, screen-reader text, focus, resize, narrow-layout, alternate-output, masked-input, mouse, and contrast receipts |
| Settings completeness | All configuration sections, source/provenance views, MCP and Skill management, provider credentials, hooks, plugin review/grants, and reset/import/export flows |
| Writer unification | Every CLI and runtime writer uses the same service; direct file writers are rejected by tests |
| Cross-host parity | Native and temporary Pi oracle project the same supported settings and semantic interaction outcomes |

Do not advance either surface to cutover-ready from snapshots or isolated widget tests. The release gate requires the production launcher, real browser or PTY paths, clean packaging, and supported-platform evidence.
