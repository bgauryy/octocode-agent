# RFC: OctocodeShell — an own TUI shell replacing Pi's InteractiveMode

Status: **Phase C alpha (skeleton landed)** · Owner: octocode-pi-extension · Host: `@earendil-works/pi-coding-agent@0.80.3`

## 1. Goal

Replace Pi's `InteractiveMode` with an Octocode-owned interactive TUI shell whose
logic lives entirely in `packages/octocode-pi-extension`. The launcher
(`packages/octocode-agent`) only *selects* and *calls* it; it owns no shell logic.

Hard constraints:

- **No runtime dependency on `@earendil-works/pi-coding-agent`** from the extension
  package (peer-dep rule). The Pi runtime is received as a parameter and described by
  **local structural interfaces** (`ShellRuntime` / `ShellSession` / `ShellSessionEvent`).
- **`@earendil-works/pi-tui` is allowed** — Pi's extension loader host-aliases it, the
  same pattern already used by `src/tools/ui-overlays.ts`.

## 2. Architecture

```
launcher (octocode-agent/sdk-launcher.ts)
  │  builds AgentSessionRuntime via createAgentSessionRuntime(...)
  │  if OCTOCODE_SHELL=1: createOctocodeShell(runtime, deps).run()
  │  else / on throw: new InteractiveMode(runtime, opts).run()   ← fallback
  ▼
OctocodeShell (src/shell/shell.ts)                 ── controller (pure-ish)
  ├── subscribe(runtime.session)  → ShellSessionEvent stream
  │      message_update.text_delta      → ui.appendDelta
  │      message_update.thinking_*       → visible 🧠 block + streamed reasoning
  │      message_update.toolcall_*       → visible queued tool-call block
  │      tool_execution_start/update/end → colored call/update/result block
  │      agent_end                       → ui.print("")   (close block)
  ├── ui.onSubmit(text)
  │      /quit|/exit|exit → finish(0)
  │      else            → session.prompt(text, steer-if-streaming)
  ├── ui.onAbort()       → session.abort()
  └── run() resolves Promise<number> on quit
  ▼
ShellUi (pluggable I/O surface)
  ├── default: createPiTuiUi()  → pi-tui TUI + Container(transcript) + Editor
  └── tests:   FakeUi           → records lines/deltas, exposes submit()/abort()
```

### Event flow (runtime → screen)

The shell subscribes once via `AgentSession.subscribe(listener)`. The listener
receives `AgentSessionEvent` (the pi-agent-core `AgentEvent` union plus session
events). Alpha consumes these render-critical events:

| Event | Source anchor | Rendered as |
|---|---|---|
| `message_update` w/ `assistantMessageEvent.type==="text_delta"` | `pi-ai/dist/types.d.ts` `AssistantMessageEvent` → `{ type:"text_delta"; delta:string; partial }` | inline delta (`ui.appendDelta`) |
| `message_update` w/ `thinking_start|thinking_delta|thinking_end` | `pi-ai/dist/types.d.ts` `AssistantMessageEvent` thinking events | visible `🧠 thinking` block; deltas stream dimmed |
| `message_update` w/ `toolcall_start|toolcall_delta|toolcall_end` | `pi-ai/dist/types.d.ts` and proxy event d.ts toolcall events | queued tool-call block and streamed argument delta |
| `tool_execution_start|tool_execution_update|tool_execution_end` | `pi-agent-core` `AgentEvent` → `{ toolCallId; toolName; args/result; isError }` | colored call/update/result block with compact JSON detail |
| `agent_end` | `agent-session.d.ts` `AgentSessionEvent` (`{ type:"agent_end"; messages; willRetry }`) | blank line closing the block |

### Input flow

`createPiTuiUi()` builds a pi-tui `Editor` (`new Editor(tui, theme)`), sets
`editor.onSubmit`, and registers a `tui.addInputListener` that maps `\x03` (Ctrl+C)
and lone `\x1b` (Escape) to the abort handler. The controller is UI-agnostic: it only
sees `onSubmit(text)` / `onAbort()`.

## 3. Verified API surface

All names/signatures read from the installed `0.80.3` `.d.ts` (never guessed).

| Name | Source d.ts | Signature (relevant) |
|---|---|---|
| `AgentSessionRuntime.session` | `dist/core/agent-session-runtime.d.ts` | `get session(): AgentSession` |
| `createAgentSessionRuntime` | `dist/core/agent-session-runtime.d.ts` | `(factory, {cwd,agentDir,sessionManager,...}) => Promise<AgentSessionRuntime>` |
| `AgentSession.prompt` | `dist/core/agent-session.d.ts` | `prompt(text: string, options?: PromptOptions): Promise<void>` |
| `PromptOptions.streamingBehavior` | `dist/core/agent-session.d.ts` | `"steer" \| "followUp"` — *required if streaming* |
| `AgentSession.subscribe` | `dist/core/agent-session.d.ts` | `subscribe(listener: (e: AgentSessionEvent) => void): () => void` |
| `AgentSession.abort` | `dist/core/agent-session.d.ts` | `abort(): Promise<void>` |
| `AgentSession.isStreaming` | `dist/core/agent-session.d.ts` | `get isStreaming(): boolean` |
| `AgentSession.steer` / `followUp` | `dist/core/agent-session.d.ts` | `(text, images?) => Promise<void>` |
| `AgentSession.clearQueue` / `getSteeringMessages` / `getFollowUpMessages` | `dist/core/agent-session.d.ts` | queue accessors for message-queue UI |
| `AgentSession.compact` / `abortCompaction` | `dist/core/agent-session.d.ts` | compaction control |
| `AgentSession.cycleModel` / `setModel` | `dist/core/agent-session.d.ts` | `cycleModel(dir?) => Promise<ModelCycleResult\|undefined>` |
| `AgentSessionEvent` | `dist/core/agent-session.d.ts` | union incl. `queue_update`, `compaction_start/end`, `auto_retry_start/end`, `session_info_changed`, `thinking_level_changed` |
| `AgentEvent` | `pi-agent-core` `dist/types.d.ts` (embedded) | `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end` |
| `AssistantMessageEvent` | `pi-ai/dist/types.d.ts` | `text_delta {delta}`, `text_start/end`, `thinking_*`, `toolcall_*`, `done`, `error` |
| `AgentSessionRuntime.switchSession/newSession/fork/importFromJsonl` | `dist/core/agent-session-runtime.d.ts` | session tree/fork/resume/import |
| `InteractiveMode` | `dist/modes/interactive/interactive-mode.d.ts` | `new (runtimeHost: AgentSessionRuntime, options?: InteractiveModeOptions)`, `run(): Promise<void>` |
| `TUI` | `pi-tui/dist/tui.d.ts` | `new TUI(terminal, showHardwareCursor?)`, `addChild`, `setFocus`, `start`, `stop`, `requestRender(force?)`, `addInputListener(l) => () => void`, `showOverlay` |
| `Container` | `pi-tui/dist/tui.d.ts` | `addChild/removeChild/clear/render` |
| `Editor` / `EditorTheme` / `EditorOptions` | `pi-tui/dist/components/editor.d.ts` | `new Editor(tui, theme, options?)`; `onSubmit?`, `onChange?`, `setAutocompleteProvider`, `addToHistory`; theme `{ borderColor, selectList: SelectListTheme }` |
| `Text` | `pi-tui/dist/components/text.d.ts` | `new Text(text?, paddingX?, paddingY?)`, `setText` |
| `SelectListTheme` | `pi-tui/dist/components/select-list.d.ts` | 5 colorizer fns |
| `ProcessTerminal` / `Terminal` | `pi-tui/dist/terminal.d.ts` | `start/stop/write/columns/rows/setTitle` |
| `renderBannerWithTagline` | `src/branding/banner.ts` (this pkg) | `(theme: BannerTheme, width, version?) => string[]` |

Not yet consumed but verified-present for later phases: `FooterComponent`,
`ModelSelectorComponent`, `SessionSelectorComponent`, `TreeSelectorComponent`,
`ThinkingSelectorComponent`, `CompactionSummaryMessageComponent`,
`ToolExecutionComponent`, `CombinedAutocompleteProvider`, `KeybindingsManager`
(all in `dist/modes/interactive/components/index.d.ts` / `pi-tui`).

### Unverified / assumed (must confirm before use)

- **Auth/model preflight**: `prompt()` "throws if no model selected or no API key"
  (doc comment). The alpha catches and prints the error; a real login/model-picker
  flow (`LoginDialogComponent`, `ModelSelectorComponent`) is unverified end-to-end.
- **Extension UI context**: `InteractiveMode` wires `bindExtensions({uiContext,...})`
  so extension widgets/dialogs/`registerCommand` work. The shell does **not** yet bind
  an `ExtensionUIContext`; extension-provided overlays/commands are unwired (assumed
  needed, flow unverified).
- **RPC `get_entries` cursor semantics** (docs/rpc.md): not used by the shell; relevant
  only if the shell later exposes an RPC surface.

## 4. Parity gaps vs InteractiveMode

Tracked so the alpha is honest about what it does *not* do yet:

- **Slash commands & autocomplete** — no command palette, no `CombinedAutocompleteProvider`, no skill/`/skill:` expansion UI.
- **Dialogs** — no login, model picker, session selector, theme/thinking selectors, settings, image viewer.
- **Keybindings** — only hardcoded Ctrl+C/Escape→abort and `/quit|/exit|exit`. No `KeybindingsManager`, no Ctrl+P model cycle, no double-Ctrl+C-to-exit, no Escape-to-clear-editor.
- **Message queue / steering** — always steers mid-stream; no steer↔followUp toggle, no pending-queue display, no `clearQueue` restore-to-editor.
- **Session ops** — no `/tree`, `/fork`, `/resume`, `/new`, `/import`, `/compact` UI (runtime methods exist; UI unwired).
- **Model / thinking** — no model picker or thinking-level UI; no `modelFallbackMessage` surfacing.
- **Compaction UI** — no `compaction_start/end` progress, no summary rendering, no auto-retry (`auto_retry_*`) UI.
- **Rendering fidelity** — plain `Text` lines only; no markdown, diff, syntax highlight, tool-output collapse/expand, or full user/assistant message components. Thinking and tool-call/result events have compact visible rows, not rich expandable components yet.
- **Extension surface** — no `ExtensionUIContext` binding: extension widgets, dialogs, custom footer/header, and `registerCommand` are unwired.
- **Footer / status** — no footer data provider, token/cost/context usage, working indicator, or terminal-title updates.
- **Bash mode** — no `!`/`!!` bash execution UI.
- **Startup notices** — no changelog, update, or trust prompts.

## 5. Launcher integration (behind `OCTOCODE_SHELL=1`)

The launcher change is **out of scope for this lane** (owned by `octocode-agent`), but
the intended wiring is:

```ts
// sdk-launcher.ts, interactive branch — after runtime is built:
if (env.OCTOCODE_SHELL === '1') {
  try {
    const { createOctocodeShell } = await import('@octocodeai/pi-extension/shell');
    return await createOctocodeShell(runtime as ShellRuntime, {
      version: VERSION, theme: octocodeBannerTheme, width: process.stdout.columns,
    }).run();
  } catch (err) {
    log(`octocode-agent: OctocodeShell failed (${msg}); falling back to InteractiveMode`);
    // fall through
  }
}
const imode = new IM(runtime, { /* existing opts */ });
await imode.run();
return 0;
```

Fallback triggers: `OCTOCODE_SHELL` unset/≠`1`, or `createOctocodeShell(...).run()`
throws (import failure, unhandled shell error). The package now publishes the
`./shell` subpath export and keeps the root lazy export as a fallback for older
local builds.

## 6. Rollout phases

1. **C/D (current)** — RFC + shell controller + pluggable `ShellUi` + headless tests; launcher wiring behind `OCTOCODE_SHELL=1`; `./shell` package export; InteractiveMode fallback. Off by default while dogfooding.
2. **E** — rendering fidelity: markdown/diff/tool-output components, footer + context usage, working indicator.
4. **F** — interaction: slash commands + autocomplete, keybindings manager, message-queue/steer UI, abort/exit semantics parity.
5. **G** — dialogs & session ops: model/session/tree/fork/resume/compaction UI, login, extension `ExtensionUIContext` binding.
6. **H** — flip default (opt-out via `OCTOCODE_SHELL=0`), then remove InteractiveMode dependence.

## 7. Risks

- **Structural drift**: local interfaces can silently diverge from Pi's real types on host upgrades. Mitigation: the launcher performs the single `runtime as ShellRuntime` cast at the boundary; a contract test there (octocode-agent lane) should assert assignability against the real `AgentSessionRuntime`.
- **Shell import fallback**: the launcher prefers `@octocodeai/pi-extension/shell` and falls back to the root lazy export for older local builds; either import failing falls through to InteractiveMode.
- **Extension UI unwired**: without `bindExtensions({uiContext})`, extension tools that render overlays/dialogs or register commands won't work in the shell — a functional regression vs InteractiveMode until Phase G.
- **Auth/model preflight**: `prompt()` throwing on missing model/API key currently only prints an error; users with no configured model get a worse first-run than InteractiveMode's login flow. Address in Phase G.
- **pi-tui coupling**: deep reliance on pi-tui internals (Editor autocomplete, overlay focus) increases breakage surface on pi-tui upgrades; pin and test against the host-aliased copy.
- **Parallel banner lane**: `src/branding/banner.ts` is built by another lane; this lane consumes `renderBannerWithTagline`/`BannerTheme` and must not edit it. If its API changes, update the shell import.

## 8. Files (this lane)

- `src/shell/shell.ts` — `createOctocodeShell(runtime, deps)`, structural runtime interfaces, `ShellUi`, default pi-tui UI.
- `src/shell/index.ts` — public exports.
- `tests/shell.test.ts` — headless FakeRuntime + FakeUi driving the loop.
- `docs/SHELL.md` — this RFC.
