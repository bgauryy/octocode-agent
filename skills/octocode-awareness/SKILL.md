---
name: octocode-awareness
description: "Coordinate agents through shared repository state. Use when peers, shared plans, overlap, locks, messages, verification debt, handoffs, or reusable memory can change the next action. Skip routine solo work with no shared-state signal."
hooks:
  PreToolUse: [{ matcher: "^(?:Write|Edit|MultiEdit|NotebookEdit)$", hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/pre-edit.sh", timeout: 20 }] }]
  PostToolUse: [{ matcher: "^(?:Write|Edit|MultiEdit|NotebookEdit)$", hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/post-edit.sh", timeout: 20 }] }]
  PostToolUseFailure: [{ matcher: "^(?:Write|Edit|MultiEdit|NotebookEdit)$", hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/post-edit.sh", timeout: 20 }] }]
  SubagentStart: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/notify-deliver.sh", timeout: 20 }] }]
  Stop: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/stop-verify.sh", timeout: 20 }] }]
  SubagentStop: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/stop-verify.sh", timeout: 20 }] }]
  PreCompact: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/session-compact.sh", timeout: 20 }] }]
  SessionEnd: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/session-end.sh", timeout: 20 }] }]
  UserPromptSubmit: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/notify-deliver.sh", timeout: 20 }] }]
---
# Octocode Awareness

Use Awareness only when shared state can change the decision. The skill owns judgment; the CLI owns deterministic actions and live contracts. Derive reasoning, actions, and completion claims from observed current repository state or check evidence. Memory, file locks, search hits, expiry, and peer notes are leads—not proof.

## One coordination layer

One `octocode-awareness` binary exposes two explicit planes; do not mix their similarly named commands:

| Plane | Use | Live catalog | Store |
|---|---|---|---|
| Shared coordination | Cross-host plans/tasks, peers, messages, handoffs, locks, checks, verified memory | `guide --json`; `coordination schema commands` | `~/.octocode/octocode.sqlite3` (or Octocode home/DB override) |
| Advanced workflow | `attend`, explicit WORK/runs, signals, refinements, reflection, queries, maintenance | `schema commands --compact` | `~/.octocode/memory/awareness.sqlite3` (or `OCTOCODE_MEMORY_HOME`/`--db`) |

Shared commands use `coordination …`; `guide`, `status`, `message`, `handoff`, and `check` have shortcuts. Advanced commands use root nouns. Direct `status` is shared; `workspace status` is advanced. Follow `next` and exact schemas.

The only documented runner is `npx @octocodeai/octocode-awareness …`. Code hosts import `getExternalAgentAwarenessGuide`; do not copy policy or teach host-specific command paths.

In references, `<cli>` means that runner.

## First run

Run `npx @octocodeai/octocode-awareness config show --compact`. If the file is missing, read [configuration](references/configuration.md), show its five questions together, wait, and create it only from all answers; never infer defaults. Run `config validate` and operate from the file. Creating it is not hook-install approval: immediately before every real `hooks install`, show the dry-run target and ask separately; without an explicit yes, do not install.

Then run `npx @octocodeai/octocode-awareness init --compact` once for the advanced store. Shared commands create/check their store on use. Inspect only the needed plane:

```bash
npx @octocodeai/octocode-awareness guide --json
npx @octocodeai/octocode-awareness status --workspace "$PWD"
npx @octocodeai/octocode-awareness attend --workspace "$PWD" --query "<task>" --compact
```

## Quick usage

- Orient with shared `status` or advanced `attend`.
- Choose owned/ready tasks or start bounded WORK; expose edited paths.
- Inspect/message ordinary overlap; lock only unsafe overlap.
- Run the check, then shared `check mark` or advanced `verify mark`.
- Store only verified reusable memory; re-check recall.
- Leave a named task/signal/handoff/refinement only when work remains.

## Bounded flow

Inspect relevant shared state; claim scoped work; expose edited paths; keep leases alive; message consequential overlap; run the declared check; record its observed receipt with `check mark`; then close work. Ordinary overlap is advisory. Lock only unsafe overlap. Leave a handoff only for continuation and store only verified reusable memory.

Hooks automate presence and conflict gates; they do not choose tasks, assert success, or create truth. Never bypass a peer lock. Destructive cleanup remains dry-run-first and requires normal authorization.

`hooks install|check|remove --host` supports `claude|codex|cursor`. Pi uses `@octocodeai/pi-extension` native events and must never be passed as an install host.

## Detail routes

- Shared commands and outcomes: [flow matrix](references/flow-matrix.md); live truth: `npx @octocodeai/octocode-awareness coordination schema commands`.
- Prompt/`AGENTS.md` export: `instructions export --format prompt|agents-md|json`
- Configuration, defaults, supported toggles, and JSON contract: [configuration](references/configuration.md) and [schema](references/awareness-config.schema.json).
- Storage ownership and host composition: [architecture](references/architecture.md).
- Research evidence: [Octocode](references/octocode.md) via MCP or `npx octocode`.
- Runtime workflows: [setup](references/agent-cheatsheet.md), [plan/run](references/plan-task-workflow.md), [locks/verify](references/lock-protocol.md), [signals](references/coordination-protocol.md), [memory](references/memory-recall.md), [hooks](references/hooks.md), and [queries](references/output-routing.md).

For package/host installation, read `README.md`; initialization and runtime diagnosis start with the CLI, not prompt-authored shell logic. Edit only this repo-root skill source; rebuild mirrors with `yarn workspace @octocodeai/octocode-awareness build`.
