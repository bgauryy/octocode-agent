# Octocode Pi UI

This extension keeps the TUI compact by default and puts detail behind slash commands.

## Main surfaces

| Surface | Where | Purpose |
|---|---|---|
| Header | session start | Brand, loaded capability hint, common commands |
| Status footer | always-on | Octocode label, thinking level, context/turn metrics, agent counts |
| Working indicator | during turns | Branded `◆ Octocode` spinner/message |
| Live agent progress | while workers run | Agent ledger animates: braille spinner + live elapsed, refreshed every 1s until no worker is active (ticker is `unref`-ed and self-stops) |
| Dashboard | `/octocode` | Status, agents, setup paths, skills, health, next actions |
| Agent ledger | `/octocode-agents` + below editor | Spawned-worker state and controls |

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
/octocode-agents · /octocode-status · /octocode-harness · /octocode-setup · /octocode-skills-update
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

## Width and theme rules

- Rendered lines are built through shared width-safe renderers.
- Use theme colors from callback contexts only.
- Footer/status success is quiet; warnings and errors notify.
- Keep widgets compact; use commands for detailed output.

## Troubleshooting

| Symptom | Action |
|---|---|
| Extension looks inactive | Run `/octocode`, then `/octocode-harness` |
| Ledger is noisy | Run `/octocode-agents hide` or `/octocode-agents prune` |
| Context bar is near full | Compact or use `/octocode-status` for details |
| Worker says done too early | Inspect and verify acceptance yourself |
