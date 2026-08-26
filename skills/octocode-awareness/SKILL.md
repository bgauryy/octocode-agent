---
name: octocode-awareness
description: "Coordinate agents through one shared workspace ledger. Use when peers, shared plans, overlap, locks, messages, verification debt, handoffs, or reusable memory can change the next action. Skip routine solo work with no shared-state signal."
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

Use Awareness only when shared state can change the decision. Derive reasoning, actions, and completion claims from observed repository state or check evidence. Memory, file locks, search hits, expiry, and peer notes are leads—not proof.

## One coordination layer

Pi and external agents use the same workspace-scoped ledger at the Octocode home (`~/.octocode/octocode.sqlite3`, or `OCTOCODE_HOME`/`OCTOCODE_DB_PATH`).

| Host | Shared coordination surface |
|---|---|
| Pi / Octocode harness | Imports `@octocodeai/octocode-awareness`; native `plan`, `lock`, `message`, and `memory` compose it. Use `$OCTOCODE_AWARENESS_CLI` for missing diagnostics. |
| External installed agent | `npx -p @octocodeai/octocode-awareness octocode-awareness …` |
| This monorepo after build | `node packages/octocode-awareness/out/octocode-awareness.js …` |

One root CLI owns coordination, reflection, sessions, and maintenance. Shared-ledger commands use `octocode-awareness coordination …`; `guide`, `status`, `message`, `handoff`, and `check` have direct shortcuts. Run `guide --json` for package-owned policy plus the live command catalog, `coordination schema commands` for exact shared flags, or `schema commands --compact` for all workflows. Code hosts import `EXTERNAL_AGENT_AWARENESS_PROMPT` or `getExternalAgentAwarenessGuide`; do not copy them. In Pi, prefer native tools.

## Quick usage

| Need | Live family | Output | Why |
|---|---|---|---|
| Learn capabilities | `guide --json`; `schema commands` | Policy and current actions/flags | Avoid stale host copies. |
| Discover peers/state | `status`; agent/message/handoff | Snapshot or entities | Inspect only decision-changing state. |
| Share execution | plan/task/check | Graph, lease, next action, receipt | Separate ownership, done, and proof. |
| Expose overlap | work/lock | Presence, conflict, or release | Advisory by default; exclusive only when unsafe. |
| Reuse learning | memory | Ranked leads or mutation result | Share verified learning, then re-check it. |
| Enforce edits | hooks | Proposed config or conflict | Apply the same lock gate across hosts. |

## Bounded flow

Inspect relevant shared state; claim scoped work; expose edited paths; keep leases alive; message consequential overlap; run the declared check; record its observed receipt with `check mark`; then close work. Ordinary overlap is advisory. Lock only unsafe overlap. Leave a handoff only for continuation and store only verified reusable memory.

Hooks automate presence and conflict gates; they do not choose tasks, assert success, or create truth. Never bypass a peer lock. Destructive cleanup remains dry-run-first and requires normal authorization.

## Detail routes

- Shared commands and outcomes: [flow matrix](references/flow-matrix.md); live truth: `octocode-awareness coordination schema commands`.
- Storage ownership and Pi composition: [architecture](references/architecture.md).
- Runtime workflows: [setup](references/agent-cheatsheet.md), [plan/run](references/plan-task-workflow.md), [locks/verify](references/lock-protocol.md), [signals](references/coordination-protocol.md), [memory](references/memory-recall.md), [hooks](references/hooks.md), and [queries](references/output-routing.md).

For first-time installation or runtime diagnosis, read `README.md` and run `node skills/octocode-awareness/scripts/install.mjs`. Edit only this repo-root skill source; rebuild mirrors with `yarn workspace @octocodeai/octocode-awareness build`.
