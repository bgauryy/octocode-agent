---
name: octocode-awareness
description: "Coordinate shared-repo signals and recover Awareness state. Use when active peers or overlap, shared planning, unread messages, locks, verification debt, continuation recovery, or reusable memory can change the next action. Do not load for routine solo start/finish ceremony."
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
Use when live shared state changes the next action. AGENTS routes; skill decides; tools or CLI/SQLite act; hooks automate deterministic edges. SQLite is canonical; memory is a lead, not proof.

Choose the host surface before acting:
| Context | Use |
|---|---|
| Pi / Octocode harness | First-class `plan`, `lock`, `message`, and `memory`; `$OCTOCODE_AWARENESS_CLI` is the bundled **Lite** diagnostics/recovery CLI |
| Package development after build | `node packages/octocode-awareness/out/octocode-awareness.js` |
| Installed/global smoke | `npx @octocodeai/octocode-awareness` |

In Pi, no manual lifecycle loop: `plan` owns session/shared execution and observed check receipts; registry, advisory presence, and mutation lock checks are automatic. There is no public status-snapshot tool; use `lock` only for sensitive/non-mergeable state, `message` for needed peer coordination, and the Lite CLI only for targeted diagnostics/recovery.

Full-package hook hosts set `OCTOCODE_AGENT_ID` per session. Run live-state actions through the CLI selected above. Never put `node ...` in a shell variable; use `node "$AWARENESS_CLI" ...`.

Full-package core loop (not Pi's default model flow): `attend -> work start -> edit/check -> work end -> verify mark -> verify audit`.
1. BEFORE: `attend --query "<task>" --compact`; follow `next`; state goal, acceptance, scope, evidence. Recall memory only if it can change the plan.
2. DURING: open WORK (default) or claim a plan task (shared backlogs); declare paths by hooks or `work start`; read peers. Ordinary overlap is allowed; reserve exclusivity for unsafe/non-mergeable edits and never bypass conflict.
3. AFTER: check while present; `task submit`/`work end`; `verify mark`; `verify audit`. Expiry never means success.
4. OPTIONAL: `reflect record --task "<task>" --outcome <success|failure> --lesson "<text>"` only for verified reusable outcomes; run `maintenance digest` cleanup only under real pressure.

Hooks automate deterministic edges, not judgment: pre-edit declares presence and blocks real exclusive conflicts; post-edit advances the run; Stop gates on unverified work; SessionEnd/PreCompact capture continuation. Hooks never choose plans, locks, success, learning, or cleanup. Use `work start --exclusive` only for sensitive/non-mergeable files; `lock wait/prune` is recovery.

Delegate only routine deterministic Awareness CLI reads/writes/maintenance when cheaper. Use the smallest capable configured low-cost agent, require `--compact`, cap receipt at 512 bytes. Lead keeps destructive approval, conflict handling, memory truth, and verification.

Feature map — load one reference for exact flags (`<cli> schema command <noun> [action]`; use `schema command attend`, not `attend run`):
- Unsure which flow applies: trigger → command → verify/close matrix — `references/flow-matrix.md`.
- Orient a full-package run when a shared signal needs action: `attend` — `references/agent-cheatsheet.md`.
- Plan vs task vs WORK (shared backlog vs solo edit): `references/plan-task-workflow.md`.
- File presence & overlap (advisory, mergeable edits): `work start|touch|list|show` — `references/files-awareness.md`.
- Exclusivity for unsafe/non-mergeable edits + verify debt: `work start --exclusive`, `lock acquire|wait|release|prune`, `verify mark|audit` — `references/lock-protocol.md`.
- Communicate with other agents (blocker/question/handoff/decision/fyi) and durable follow-up: `signal publish|list|reply|ack|resolve` and `refinement set|get` — `references/coordination-protocol.md`.
- Recall/record durable lessons: `memory recall --smart` / `memory record` — `references/memory-recall.md`.
- Hooks + hosts (Claude/Codex/Cursor): `references/hooks.md`.
- Architecture / session / storage: `references/architecture.md`.
- Query views & docs output: `references/output-routing.md`; unknown owner: `docs list --compact`, then `docs show <name>`.
- Reflection / skill changes / cleanup: `references/learning-loop.md`.

first activation outside Pi: load `README.md`; initialize a missing store once, then `attend`. Claude uses frontmatter; do not install duplicate hooks. Codex/Cursor use `references/hooks.md`; Pi uses the Octocode harness-native plan and mutation flow. Diagnose with `node skills/octocode-awareness/scripts/install.mjs`. Rebuild with `yarn workspace @octocodeai/octocode-awareness build`; never edit mirrors.
