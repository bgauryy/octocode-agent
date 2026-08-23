# Octocode Pi UI

This extension keeps the TUI compact by default and puts detail behind slash commands.

## Main surfaces

| Surface | Where | Purpose |
|---|---|---|
| Header | session start | Brand, loaded capability hint, common commands |
| Status footer | always-on | The sole spawned-agent surface: Octocode label, context/turn metrics, agent counts, one row per worker, directional `msg→` / `msg←` communication activity, git/blocked/failed segments, and the effort dial `◉ <level>`; detailed thinking mode also appears as the separate `octocode-thinking` status entry |
| Working indicator | during turns | `✦ ✧ ✶ ✧` spinner frames with a `Thinking…` message (the word "Octocode" is kept out of the frames to avoid "Octocode Octocode…" doubling) |
| Unified status panel | below-editor widget (`octocode-status-panel`) | One block: Model → Plan → Awareness; the Plan header can show multiple active parallel lanes. Spawned agents are intentionally excluded so the footer is their single stable location; persistent while a model is known, cleared on shutdown |
| Thinking blocks | `OCTOCODE_SHELL=1` runtime stream | Shows `🧠 thinking` start/end rows and streams reasoning deltas instead of dropping them |
| Tool rows | tool streams/renderers | Shared renderers show a `◇` call row, animated braille running state, then a result row that always carries the outcome: structured stats/paths/preview when the tool reports them, otherwise `→ first line of the response` (ctrl+o expands the full text); the Octocode shell also prints call/update/result blocks |
| Live agent progress | while workers run | Footer rows show name, state, elapsed time, current tool/progress, and latest message direction; refreshed every 1s until no worker is active (ticker is `unref`-ed and self-stops) |
| Dashboard | `/octocode` | Status, agents, tools, setup paths, skills, health, and modern next actions |
| Agent ledger | custom footer + `/octocode-agents` details | Spawned-worker state, message flow, and controls without duplicate status/widget rows |
| Decision picker | `askUser` tool | Inline in-flow list for real user choices — rendered in the message flow (not a floating overlay): single pick, multi-select (space toggles, min/max), per-option previews, and short sequential forms; falls back to inline questions when no interactive UI is available |
| Inline images | expanded tool renderers | chrome-debug / browser-agent screenshots render inline (Kitty/iTerm2) with a `🖼` placeholder on terminals without image support |
| Worker inbox | `/octocode-inbox` | Two-stage overlay: pick a worker, then view transcript / steer / kill; completions and failures fire OSC 9 desktop notifications + a terminal-title flash |
| Command palette | `/octocode-palette` or `ctrl+shift+k` | Prefix-filter picker over every slash command and direct actions (`OCTOCODE_PALETTE_KEY` overrides the shortcut) |
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
✓ tools: 0 native Pi tools + 17 support tools
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
Work-state commands: `/octocode-plan` (`new <goal>` = plan mode: research → `plan(propose)` → approve/adjust/reject gate; write tools are **blocked by a `tool_call` hook** until approval — `off` lifts it; a `plan mode` status chip shows while on), `/octocode-tasks`, `/octocode-agents`, `/octocode-inbox`, `/octocode-cron`, `/cron`.
Configuration and integration commands: `/octocode-mcp`, `/mcp`, `/octocode-setup`, `/octocode-skills`, `/octocode-skills-update`, `/octocode-theme`, `/octocode-chrome`.
Modern TUI commands: `/octocode-palette`, `/octocode-dial`, `/octocode-footer` (`legend` explains every segment), `/octocode-permissions` (level cycle: `ctrl+shift+a`), `/octocode-profile` (apply `~/.octocode/profiles.json` live), `/octocode-plan html` (live local plan page), `/octocode-rewind`, `/octocode-watch`, `/octocode-export`.

Scrollback rule (pi-tui `tui-main-screen.js`): a change to any line **above the visible viewport** — or a width/height change — forces a full redraw that clears the screen *and scrollback*. Octocode therefore renders **nothing above the transcript** (no `setHeader`; the session name lives only in the terminal title), keeps every transcript entry/message/tool row a pure function of its data, and confines live state to the footer, status chips, and the below-editor panel — all registered once and repainted via `tui.requestRender`. Per-frame render closures never do O(session) work: context usage is sampled on events + the 1 s tick (`pi.getContextUsage()` rebuilds the session branch per call), and the banner's version read is memoized. Diagnose any remaining full redraw with `PI_DEBUG_REDRAW=1` (pi logs each `fullRender:` reason to `pi-debug.log`).

Motion language: the transcript and footer use no animated decoration — pi's working spinner is the only moving glyph; live agent rows only update factual elapsed/state/message text. Attention flags (`⚠ ✗ ✉`, ≥90% context) are painted warning/error **and bold**; brightness always means state, never decoration. The banner card is a fixed purple gradient — an animated banner at the top of the scrollback invalidated pi-tui's line diff on every repaint and caused scroll jumps.

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
| `msg→ <action>` | Parent sent, steered, or queued a message to this worker | Watch the queued count or wait for the turn |
| `msg← reply` | Worker replied to the parent | Read the preview or inspect with `AgentMessage status` |

## Visual contract

`src/tui/cli-design.ts` owns the shared Octocode CLI language: core glyphs, spinner frames, transcript tool rows, thinking rows, compact payload summaries, and raw ANSI fallback colors. Pi component renderers still use `src/tools/render-helpers.ts` for width-safe output, but they import symbols/progress primitives from this contract so the extension UI and `OCTOCODE_SHELL=1` transcript do not drift.

## Color system

`src/tui/palette.ts` (`TOKEN`) is the only place a *kind of data* is bound to a theme token; `themes/octocode-{dark,light}.json` own the hex values. Every surface — banner, header, footer, plan panel, tool rows, ask-user, agent ledger, overlays — paints through `paint(theme, token, …)` so one colour keeps one meaning everywhere:

| Colour | Token(s) | Means | Never used for |
|---|---|---|---|
| **Purple** (`accent`) | `brand`, `title` | Octocode identity: the `◆` mark, banner body, tool names, the focused/selected row, and anything **in flight** (spinner, `running`, `doing`, `Fetching…`, `Spawning agent…`) | warnings, success |
| **Lavender** (`mdLink`) | `link` | Links, peer/agent messaging (`✉` unread, `queued` workers), model thinking rows | decoration |
| **Sky** (`mdCode`) | `path`, `symbol` | File paths and identifiers — the data the user reads most; distinct from purple so a path never looks like a tool title | — |
| **Gold** (`warning`) | `warning` | **Act on me**: blocked workers `⚠`, `perm relaxed`, ≥75 % context, genuine tool warnings | frames, spinners, in-flight labels, "no match", cancels, pros/cons |
| **Green / Red** | `success`, `error`, `diffAdd`, `diffRemove` | Outcomes only: done/failed rows, `✓`/`✗` result glyphs, `+`/`-` diff lines | selection state, recommended badges |
| **Default fg** | `count`, `bright` | Values (counts, totals) and pending plan rows — bright against dim labels | — |
| **Grey ramp** | `muted` → `dim` → theme `faint` | Secondary text → chrome (separators, `│` bars, hints, finished plan rows) → rules | primary content |

The footer speaks in words, not glyphs: `context ▓▓░░ 25% · 250k/1M · turn 8 · 14s · session 1h · agents 3 (2 live) · now: … · mail 2 · blocked 1 · failed 1 · dial deep · perm default · prompt ~12k · main (5 changed)`. Below it, **one row per subagent** — `agent <name> (<id>) · <state> · <elapsed> · now: <activity>` — live workers first, at most four rows then `… N more agents`; the state word carries the ledger colour (running purple, blocked gold-bold, failed red-bold, done green). Hidden at compact density (`/octocode-footer compact`).

Attention states in the footer (`⚠`, `✗`, `✉`, near-full ctx) are additionally **bold** (`FooterSegment.attention`) — the only emphasis in the toolbar, so bold always means "look here". Per-row budget: at most three colours plus the grey ramp.

Raw ANSI output (shell transcript rows, `coloredDiff`) goes through `cli-design.ts`'s `ansiForToken` fallback map, which mirrors the theme mapping (`linkUrl` → dim, `bright` → bold) and honours `NO_COLOR`.

## Width and theme rules

- Rendered lines are built through shared width-safe renderers.
- Use theme colors from callback contexts when Pi provides a theme; raw shell rows use the visual contract's `NO_COLOR`-aware fallback.
- The `askUser` decision picker uses Pi `ctx.ui.custom(builder)` inline (no overlay options) so the prompt appears in the message flow at the bottom, reading as part of the conversation rather than a floating overlay box.
- Footer/status success is quiet; warnings and errors notify.
- Keep widgets compact; use commands for detailed output.

## Troubleshooting

| Symptom | Action |
|---|---|
| Extension looks inactive | Run `/octocode`, then `/octocode-harness` |
| Ledger is noisy | Run `/octocode-agents hide` or `/octocode-agents prune` |
| Context bar is near full | Compact or use `/octocode-status` for details |
| Worker says done too early | Inspect and verify acceptance yourself |
