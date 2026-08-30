# TUI and settings implementation guide

Status: production-composed candidate; release remains `HOLD`.

This page routes implementation work. The normative terminal contract is [OpenTUI terminal core](pi-coding-agent-removal/OPENTUI_TERMINAL_CORE.md), the widget contract is [OpenTUI widgets and accessibility](11-OPENTUI-WIDGETS-AND-ACCESSIBILITY.md), and the settings contract is [settings web UI](pi-coding-agent-removal/SETTINGS_WEB_UI.md).

## Composition boundaries

The launcher chooses the immutable mode before constructing terminal resources. Interactive mode owns the OpenTUI renderer and single input reader. Print, JSON, and RPC modes never initialize the terminal. All modes consume the same semantic runtime events; output adapters decide only how to project them.

Settings use one registry and service for validation, revision control, redaction, and atomic persistence. The terminal `/settings [section]` command opens the protected loopback page. Neither the page nor a CLI command may parse or write configuration independently.

```text
runtime events ─▶ semantic events/chrome facts ─▶ PresentationState
                                                     │
                                                     ├─▶ state + viewport chrome projector
                                                     ├─▶ widget controller ─▶ OpenTUI renderer
                                                     └─▶ accessible text projection

CLI and browser actions ─▶ SettingsService ─▶ validated atomic storage
                                     └──────▶ next-session runtime projection
```

## Current verified slice

- Typed widgets and generic presentation surfaces cover messages, thinking, tool
  calls, Skills, plan, ask, progress/tasks, input, footer, diagnostics, and
  errors.
- The reducer owns state; widgets render typed view models and do not read storage directly.
- The reducer owns working, interaction, runtime identity, trust, and connection
  facts. A pure state-plus-viewport projector owns header/footer mode, width,
  and key hints; the launcher cannot write those display snapshots.
- Ask, plan, progress, and task updates share semantic events with headless modes.
- The conversation is the primary surface. The activity rail scrolls on large
  terminals and yields to the current action and composer on short narrow
  terminals.
- Global focus traversal stays bounded as history grows. It includes at most the
  transcript, one relevant tool, the authoritative plan, active notifications,
  and the latest generic surface.
- Runtime plan state has one visible owner: the plan widget suppresses a generic
  duplicate `plan` tool row. Only the three newest transient notifications stay
  in visible chrome; bounded older history remains in alternate output.
- `--accessible` keeps the interactive composer and nonsensitive controls while
  adding complete linear semantic output.
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
8. Visible chrome presents each canonical fact once; transcript, tool, plan,
   notification, and generic surfaces do not compete for the same authority.
9. Viewport width, focus, composer drafts, and native controls remain
   renderer-local. Runtime identity, trust, connection, working state, and
   interaction state remain in `PresentationState`.

## Release work

| Workstream | Required evidence |
| --- | --- |
| Terminal packaging | Clean install and packed-artifact run with the approved OpenTUI/native dependency route |
| Platform support | PTY and restoration matrix on every supported platform and Node version |
| Accessibility | Keyboard-only, screen-reader text, focus, resize, narrow-layout, alternate-output, masked-input, mouse, and contrast receipts |
| Settings completeness | All configuration sections, source/provenance views, MCP and Skill management, provider credentials, hooks, plugin review/grants, and reset/import/export flows |
| Writer unification | Every CLI and runtime writer uses the same service; direct file writers are rejected by tests |
| Cross-host parity | Native and the independent Pi extension project the same supported settings and semantic interaction outcomes |

Do not advance either surface to cutover-ready from snapshots or isolated widget tests. The release gate requires the production launcher, real browser or PTY paths, clean packaging, and supported-platform evidence.
