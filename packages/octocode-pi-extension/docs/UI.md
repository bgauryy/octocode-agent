# Octocode Pi UI

This extension keeps the TUI compact by default and puts detail behind slash commands.

## Main surfaces

| Surface | Where | Purpose |
|---|---|---|
| Header | session start | Brand, loaded capability hint, common commands |
| Status footer | always-on | Octocode label, context/turn metrics, agent counts, plan/git/blocked/failed segments (thinking level is a separate `octocode-thinking` status entry) |
| Working indicator | during turns | `✦ ✧ ✶ ✧` spinner frames with a `Thinking…` message (the word "Octocode" is kept out of the frames to avoid "Octocode Octocode…" doubling) |
| Unified status panel | below-editor widget (`octocode-status-panel`) | One block: Model → Plan → Awareness → Agents sections; persistent while a model is known, cleared on shutdown |
| Thinking blocks | `OCTOCODE_SHELL=1` runtime stream | Shows `🧠 thinking` start/end rows and streams reasoning deltas instead of dropping them |
| Tool rows | tool streams/renderers | Shared renderers show a `◇` call row, animated braille running state, compact stats/paths, and colored success/error; the Octocode shell also prints call/update/result blocks |
| Live agent progress | while workers run | Agent ledger animates: braille spinner + live elapsed, refreshed every 1s until no worker is active (ticker is `unref`-ed and self-stops) |
| Dashboard | `/octocode` | Status, agents, setup paths, skills, health, next actions |
| Agent ledger | `/octocode-agents` + below editor | Spawned-worker state and controls |
| Decision picker | `askUser` tool | Focused overlay list for real user choices; falls back to inline questions when no interactive UI is available |

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
/octocode-now · /octocode-tasks · /octocode-skills · /octocode-agents · /octocode-cron · /octocode-status
```

Warnings appear when the context is high, assets are missing, or search falls back to a weaker provider.

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
