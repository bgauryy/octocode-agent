---
name: octocode-awareness
description: "Use before starting and before finishing any repo task; also for planning, edits, reviews, tests, handoffs, multi-agent/file overlap, verification debt, memory, locks, signals, hooks, or repo learning — even solo."
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
Use at repo task start and finish. AGENTS routes; skill decides; CLI/SQLite acts; hooks automate deterministic edges. SQLite is canonical; memory rows are leads, not proof — verify before trust.

Choose the runnable CLI before acting:
| Context | Use |
|---|---|
| Pi / Octocode harness | `npx @octocodeai/octocode-awareness` (⚠ `$OCTOCODE_AWARENESS_CLI` points at the bundled **Lite** CLI — different command set; do not use it for `attend`/`signal`/`reflect`) |
| Package development after build | `node packages/octocode-awareness/out/octocode-awareness.js` |
| Installed/global smoke | `npx @octocodeai/octocode-awareness` |
| Missing local `out/` | run `yarn workspace @octocodeai/octocode-awareness build` first |

Set `OCTOCODE_AGENT_ID` per agent/session. Run live-state actions through the CLI you chose. Do not put `node ...` inside a shell variable and run it; use `node "$AWARENESS_CLI" ...`.

Core loop: `attend -> work start -> edit/check -> work end -> verify mark -> verify audit`.
1. BEFORE: `attend --query "<task>" --compact`; follow `next`; state goal, acceptance, scope, evidence. Recall memory only if it can change the plan.
2. DURING: open WORK (default) or claim a plan task (shared backlogs); declare paths by hooks or `work start`; read peers. Ordinary overlap is allowed; reserve exclusivity for unsafe/non-mergeable edits and never bypass conflict.
3. AFTER: check while present; `task submit`/`work end`; `verify mark`; `verify audit`. Expiry never means success.
4. OPTIONAL: `reflect record --task "<task>" --outcome <success|failure> --lesson "<text>"` only for verified reusable outcomes; run `maintenance digest` cleanup only under real pressure.

Hooks automate deterministic edges, not judgment: pre-edit declares file presence + peer awareness and blocks only on a real exclusive-lock conflict; post-edit logs the edit and advances the run lifecycle; Stop/SubagentStop gate on unverified work; SessionEnd/PreCompact capture a handoff signal. Hooks never choose plans, locks, success, learning, or cleanup. Use `work start --exclusive` only for sensitive/non-mergeable files; `lock wait/prune` are recovery, and wait-clear still needs a `work show` presence check before acquire.

Delegate only routine deterministic Awareness CLI reads/writes/maintenance when cheaper. Use the smallest capable configured low-cost agent, require `--compact`, cap receipt at 512 bytes. Lead keeps destructive approval, conflict handling, memory truth, and verification.

Feature map — when to use what, then load one reference for exact flags (`<cli> schema command <noun> [action]` or `<command> --help`; direct nouns use `schema command attend`, not `attend run`):
- Unsure which flow applies: trigger → command → verify/close matrix — `references/flow-matrix.md`.
- Orient / next action: `attend` (start every task) — `references/agent-cheatsheet.md`.
- Plan vs task vs WORK (shared backlog vs solo edit): `references/plan-task-workflow.md`.
- File presence & overlap (advisory, mergeable edits): `work start|touch|list|show` — `references/files-awareness.md`.
- Exclusivity for unsafe/non-mergeable edits + verify debt: `work start --exclusive`, `lock acquire|wait|release|prune`, `verify mark|audit` — `references/lock-protocol.md`.
- Communicate with other agents (blocker/question/handoff/decision/fyi) and durable follow-up: `signal publish|list|reply|ack|resolve` and `refinement set|get` — `references/coordination-protocol.md`.
- Recall/record durable lessons: `memory recall --smart` / `memory record` — `references/memory-recall.md`.
- Hooks + hosts (Pi/Codex/Cursor/Claude): `references/hooks.md`.
- Architecture / session / storage: `references/architecture.md`.
- Query views & docs output: `references/output-routing.md`; unknown owner: `docs list --compact`, then `docs show <name>`.
- Reflection / skill changes / cleanup: `references/learning-loop.md`.

first activation: load `README.md`; if the SQLite store may not exist, run `maintenance init --compact` once; then run `attend`. Claude uses frontmatter; do not install duplicate project hooks. Codex/Cursor use `references/hooks.md`; Pi uses its bridge. Diagnose with `node skills/octocode-awareness/scripts/install.mjs`. Rebuild with `yarn workspace @octocodeai/octocode-awareness build`; never edit mirrors.
