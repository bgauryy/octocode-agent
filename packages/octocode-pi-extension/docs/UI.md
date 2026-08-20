# Octocode Pi UI

This extension keeps the TUI compact by default and puts detail behind slash commands.

## Main surfaces

| Surface | Where | Purpose |
|---|---|---|
| Header | session start | Brand, loaded capability hint, common commands |
| Status footer | always-on | Octocode label, context/turn metrics, agent counts, git/blocked/failed segments, and the effort dial `◉ <level>`; detailed thinking mode also appears as the separate `octocode-thinking` status entry |
| Working indicator | during turns | `✦ ✧ ✶ ✧` spinner frames with a `Thinking…` message (the word "Octocode" is kept out of the frames to avoid "Octocode Octocode…" doubling) |
| Unified status panel | below-editor widget (`octocode-status-panel`) | One block: Model → Plan → Awareness → Agents sections; the Plan header can show multiple active parallel lanes, and the Agents section shows live running rows; persistent while a model is known, cleared on shutdown |
| Thinking blocks | `OCTOCODE_SHELL=1` runtime stream | Shows `🧠 thinking` start/end rows and streams reasoning deltas instead of dropping them |
| Tool rows | tool streams/renderers | Shared renderers show a `◇` call row, animated braille running state, compact stats/paths, and colored success/error; the Octocode shell also prints call/update/result blocks |
| Live agent progress | while workers run | Agent ledger animates: Octocode sparkle spinner + live `running` label + elapsed, refreshed every 1s until no worker is active (ticker is `unref`-ed and self-stops) |
| Dashboard | `/octocode` | Status, agents, tools, setup paths, skills, health, and modern next actions |
| Agent ledger | `/octocode-agents` + below editor | Spawned-worker state and controls |
| Decision picker | `askUser` tool | Focused overlay list for real user choices — single pick, multi-select (space toggles, min/max), per-option previews, and short sequential forms; falls back to inline questions when no interactive UI is available |
| Inline images | expanded tool renderers | chrome-debug / browser-agent screenshots render inline (Kitty/iTerm2) with a `🖼` placeholder on terminals without image support |
| Worker inbox | `/octocode-inbox` | Two-stage overlay: pick a worker, then view transcript / steer / kill; completions and failures fire OSC 9 desktop notifications + a terminal-title flash |
| Command palette | `/octocode-palette` or `ctrl+o` | Prefix-filter picker over every slash command and direct actions (`OCTOCODE_PALETTE_KEY` overrides the shortcut) |
| Mention autocomplete | editor `@` / `#` | `@` completes worker ids/names and skill names, `#` completes plan steps; delegates to Pi's file completion otherwise |
| Effort dial | `/octocode-dial` + footer `◉ <level>` | One knob for thinking level + worker parallelism (`low`/`medium`/`high`/`ultra`); persisted and restored per session |
| Checkpoints | `/octocode-rewind` | Shadow-git snapshots taken automatically before each user prompt; restore files (and optionally rewind the conversation) without ever touching the user's repo |
| Watch mode | `/octocode-watch` | Comments ending in `AI!` saved from any editor are picked up and injected as prompts (steer mid-turn, follow-up otherwise) |
| Conversation cards | compaction / handoff events | Branded collapsed/expanded cards for compaction checkpoints and awareness handoffs (rich detail stays out of the LLM context) |
| Branded export | `/octocode-export` | Takes a pi `/export` HTML file and writes an Octocode-branded `-octocode.html` sibling |

## Dashboard

Run:

```text
/octocode
```

The dashboard is scan-first:

```text
◆ Octocode dashboard
Status
✓ system prompt: found
✓ tools: 13 native Pi tools + 7 support tools
✓ metrics: ctx ▓▓▓▓▓░░░░░ 50% (50k/100k)
Agents
Octocode agents: none
Health
✓ no dashboard warnings
Next actions
/octocode-palette · /octocode-now · /octocode-tasks · /octocode-skills · /octocode-agents · /octocode-inbox · /octocode-cron · /octocode-dial · /octocode-watch · /octocode-status
```

Warnings appear when the context is high, assets are missing, or search falls back to a weaker provider.

## Command inventory

Always-on orientation and health commands: `/octocode`, `/octocode-now`, `/octocode-status`, `/octocode-harness`.
Work-state commands: `/octocode-plan`, `/octocode-tasks`, `/octocode-agents`, `/octocode-inbox`, `/octocode-cron`, `/cron`.
Configuration and integration commands: `/octocode-mcp`, `/mcp`, `/octocode-setup`, `/octocode-skills`, `/octocode-skills-update`, `/octocode-theme`, `/octocode-chrome`.
Modern TUI commands: `/octocode-palette`, `/octocode-dial`, `/octocode-footer`, `/octocode-rewind`, `/octocode-watch`, `/octocode-export`.

## Agent ledger

Run:

```text
/octocode-agents
/octocode-agents inspect <id-or-prefix>
/octocode-agents kill <id-or-prefix>
/octocode-agents prune
/octocode-agents hide
```

Ledger badges:

| Badge | Meaning | User action |
|---|---|---|
| `⚠ recovery` | Evidence-free status/action loop detected | Inspect, re-diagnose, verify independently |
| `⚠ needs verify` | Done handback lacks evidence/verification | Run acceptance checks before final answer |
| `blocked` | Worker asked parent for input | Send an answer with `AgentMessage` |
| `failed` | Process/tool failed | Inspect stderr/output, then retry or kill |

## Visual contract

`src/tui/cli-design.ts` owns the shared Octocode CLI language: core glyphs, spinner frames, transcript tool rows, thinking rows, compact payload summaries, and raw ANSI fallback colors. Pi component renderers still use `src/tools/render-helpers.ts` for width-safe output, but they import symbols/progress primitives from this contract so the extension UI and `OCTOCODE_SHELL=1` transcript do not drift.

## Width and theme rules

- Rendered lines are built through shared width-safe renderers.
- Use theme colors from callback contexts when Pi provides a theme; raw shell rows use the visual contract's `NO_COLOR`-aware fallback.
- Interactive pickers use Pi `ctx.ui.custom(..., { overlay: true })` so choices appear as focused overlays instead of replacing the conversation view.
- Footer/status success is quiet; warnings and errors notify.
- Keep widgets compact; use commands for detailed output.

## Troubleshooting

| Symptom | Action |
|---|---|
| Extension looks inactive | Run `/octocode`, then `/octocode-harness` |
| Ledger is noisy | Run `/octocode-agents hide` or `/octocode-agents prune` |
| Context bar is near full | Compact or use `/octocode-status` for details |
| Worker says done too early | Inspect and verify acceptance yourself |
