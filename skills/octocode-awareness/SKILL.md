---
name: octocode-awareness
description: "Use before starting and before finishing any repo task; also for planning, edits, reviews, tests, handoffs, multi-agent/file overlap, verification debt, memory/wiki, hooks, or repo learning — even solo."
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
Use at repo task start and finish. AGENTS routes; skill decides; CLI/SQLite acts; hooks automate deterministic edges. Memory/`.octocode/` are leads; never hand-edit `.octocode/`.

`<cli>` = local `node packages/octocode-awareness/out/octocode-awareness.js` or installed `npx @octocodeai/octocode-awareness`. Set `OCTOCODE_AGENT_ID` per agent/session. Run live-state actions through the CLI.

Core loop: `attend -> work start -> edit/check -> work end -> verify mark -> verify audit`.
1. BEFORE: `attend --query "<task>" --compact`; follow `next`; state goal, acceptance, scope, evidence. Recall memory only if it can change the plan.
2. DURING: open WORK (default) or claim a plan task (shared backlogs); declare paths by hooks or `work start`; read peers. Ordinary overlap is allowed; never bypass conflict.
3. AFTER: check while present; `task submit`/`work end`; `verify mark`; `verify audit`. Expiry never means success.
4. OPTIONAL: `reflect record --lesson` only for verified reusable outcomes; clean only under pressure; project only for file readers.

Hooks automate edges, not judgment: they never choose plans, locks, success, learning, cleanup, or projection. Use `work start --exclusive` only for sensitive files; `lock wait/prune` are recovery.

Delegate only routine deterministic Awareness CLI reads/writes/maintenance when cheaper. Use the smallest capable configured low-cost agent, require `--compact`, cap receipt at 512 bytes. Lead keeps destructive approval, conflict handling, memory truth, and verification.

Load one reference when needed:
- Start/finish/unknown command: `references/agent-cheatsheet.md`; exact flags: `<cli> schema command <noun> [action]` or `<command> --help`.
- Plan/task/WORK choice: `references/plan-task-workflow.md`.
- Work/files/overlap: `references/files-awareness.md` (`touch` refreshes run files; `start --run-id` adds paths).
- Exclusive work/verify debt: `references/lock-protocol.md`.
- Signals/refinements/peers: `references/coordination-protocol.md`.
- Memory trust/write/archive: `references/memory-recall.md`.
- Hooks/hosts/Pi/Codex/Cursor/Claude: `references/hooks.md`.
- Architecture/session/storage: `references/architecture.md`.
- Output/wiki/query/docs: `references/output-routing.md`; unknown owner: `docs list --compact`, then `docs show <name>`.
- Reflection/skill changes/cleanup: `references/improve-loop.md`, `references/skill-evolution.md`.

first activation: load `README.md`, initialize once, then `attend`. Claude uses frontmatter; do not install duplicate project hooks. Codex/Cursor use `references/hooks.md`; Pi uses its bridge. Diagnose with `scripts/install.mjs --compact`. Rebuild with `yarn workspace @octocodeai/octocode-awareness build`; never edit mirrors.
