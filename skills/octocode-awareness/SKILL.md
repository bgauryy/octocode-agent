---
name: octocode-awareness
description: "Use when shared repository state can change the next action: peers, plans, overlap, locks, messages, verification debt, handoffs, or reusable memory. Skip routine solo work without a shared-state signal."
hooks:
  PreToolUse: [{ matcher: "^(?:Write|Edit|MultiEdit|NotebookEdit)$", hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/pre-edit.sh", timeout: 20 }] }] # run before edits
  PostToolUse: [{ matcher: "^(?:Write|Edit|MultiEdit|NotebookEdit)$", hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/post-edit.sh", timeout: 20 }] }] # run after successful edits
  PostToolUseFailure: [{ matcher: "^(?:Write|Edit|MultiEdit|NotebookEdit)$", hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/post-edit.sh", timeout: 20 }] }] # run after failed edits
  SubagentStart: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/notify-deliver.sh", timeout: 20 }] }] # surface worker lifecycle changes
  Stop: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/stop-verify.sh", timeout: 20 }] }] # run when the parent stops
  SubagentStop: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/stop-verify.sh", timeout: 20 }] }] # run when a subagent stops
  UserPromptSubmit: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/notify-deliver.sh", timeout: 20 }] }] # deliver changed shared state before work
  Notification: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/notify-deliver.sh", timeout: 20 }] }] # record host notifications without a second hook brain
  PreCompact: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/session-compact.sh", timeout: 20 }] }] # preserve coordination before compaction
  PostCompact: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/session-compact.sh", timeout: 20 }] }] # refresh compacted-session state
  SessionEnd: [{ hooks: [{ type: command, command: "${CLAUDE_SKILL_DIR}/scripts/hooks/session-end.sh", timeout: 20 }] }] # close scoped hook work at session end
---
# Octocode Awareness

Flow: **NOTICE → INSPECT → COORDINATE → VERIFY**

The skill decides when shared state matters. The CLI owns state changes. Hooks only guard edits and surface typed pointers such as overlap or verification debt; inspect details only when the pointer could change your action.

## Start small

```bash
npx @octocodeai/octocode-awareness setup --compact
npx @octocodeai/octocode-awareness next --workspace "$PWD"
npx @octocodeai/octocode-awareness inspect workboard --workspace "$PWD"
npx @octocodeai/octocode-awareness verify --workspace "$PWD"
npx @octocodeai/octocode-awareness close --run-id <id> --workspace "$PWD"
```

All durable agent state uses the single global `$OCTOCODE_HOME/agent/agent.sqlite3` database; repositories are isolated by workspace columns, never by repository-local agent databases. Hooks use the `coordination` profile by default. Use `--db` only for an explicit isolated path.

Expert nouns remain available for plans, tasks, work, locks, verification, messages/signals, handoffs, memory, reflection, queries, and schema discovery.

## Operating rules

1. **NOTICE** — Run `next` after a meaningful shared-state signal; follow its returned action.
2. Declare bounded work and paths. Ordinary overlap is advisory; inspect and message only when edits interact.
3. Use an exclusive lock only for unsafe, non-mergeable state.
4. Run the declared check. Record only observed receipts; search hits, expiry, memories, and peer notes are leads, not proof.
5. Close work; leave a handoff only for real continuation and store only verified reusable learning.

Host adapters own automatic stable identity and observed check receipts. Do not duplicate status, presence, or verification calls when the host already projects them.

Cleanup remains dry-run-first.

Hook installation changes host configuration: preview `hooks install --host claude|codex|copilot|cursor|gemini|opencode --profile guard|coordination|full --dry-run`, show it, and ask immediately before applying. Pi uses native events.

## Load detail only when needed

- When configuring storage or ownership, load [configuration](references/configuration.md), [architecture](references/architecture.md), [data model](references/data-model.md), or the [agent cheat sheet](references/agent-cheatsheet.md).
- When coordinating shared work, load the [flow matrix](references/flow-matrix.md), [protocol](references/coordination-protocol.md), [plans/tasks](references/plan-task-workflow.md), [files](references/files-awareness.md), or [locks](references/lock-protocol.md).
- When preserving learning, load [memory](references/memory-recall.md), [learning loop](references/learning-loop.md), [homeostatic loop](references/homeostatic-loop.md), or [reflection](references/self-reflection-dialogue.md).
- When changing runtime behavior, load [hooks](references/hooks.md), [output routing](references/output-routing.md), [research](references/octocode.md), or the [config schema](references/awareness-config.schema.json).
- When maintaining generated assets, use `scripts/awareness.mjs` through the CLI, `scripts/extract-hook-files.mjs` and `scripts/hook-runner.mjs` through hook builds, `scripts/install.mjs` through installation, `scripts/smoke-multi-agent.mjs` for the documented smoke test, and `scripts/hooks/*.sh` only as host entrypoints.

Edit this repo-root source; `yarn workspace @octocodeai/octocode-awareness build` refreshes package mirrors.
