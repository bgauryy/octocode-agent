# Awareness Hooks

Hooks automate loop edges after the skill is used; they do not choose tasks or replace `attend`/verify. Export one stable `OCTOCODE_AGENT_ID`; without it, presence and peer packets do not join correctly. A config file proves presence, not execution, trust, or model-visible delivery.

| Host | Surface | Context / control |
|---|---|---|
| Claude | active skill frontmatter or `.claude/settings.json` | success/failure writes, subagent start/stop, PreCompact, SessionEnd; exit 2 blocks |
| Codex | trusted `.codex/hooks.json` | SessionStart, successful writes, subagent start/stop, PreCompact, prompt/stop; no SessionEnd/failure event |
| Cursor | `.cursor/hooks.json` | success/failure writes and lifecycle; native deny/follow-up output; subagent context delivery varies by surface/version |

Choose one surface. With Claude frontmatter, preview/remove older project or global Awareness hooks; do not also install them. Preview, install after approval, then check:

```bash
<cli> hooks install --host <codex|cursor> --project-dir . --dry-run
<cli> hooks install --host <codex|cursor> --project-dir . --compact
<cli> hooks check --host <codex|cursor> --project-dir . --strict
```

`--strict` validates exact entries and their runner. For drift: preview remove, remove, install, strict-check. Use `--host claude` only when frontmatter is unavailable.

```bash
<cli> hooks remove --host <claude|codex|cursor> --project-dir . --dry-run
<cli> hooks remove --host <claude|codex|cursor> --project-dir . --compact
```

## Write Path

1. Extract deduplicated paths; no paths → no-op.
2. Evaluate harness guard before any DB presence.
3. Resolve exactly one TASK claim, matching explicit WORK presence, or the active fallback for the same agent + stable session/transcript + workspace + artifact.
4. Declare advisory work. Existing exclusive blocks; ordinary peers succeed.
5. Emit peer context only when its fingerprint changes.
6. Post-edit logs/heartbeats. TASK/WORK stays active; scoped HOOK stays active.
7. Stop, PreCompact, or SessionEnd finalizes scoped HOOK runs once; Stop audits debt.

N edits in one scoped turn produce one PENDING HOOK with N files. TASK/WORK never merge into it. Shell creation is cross-process locked. Recursive Stop surfaces continuation debt once, then permits an unchanged recursive Stop to avoid a host loop. Missing stable session correlation uses isolated fallback. Correlation loss never marks success.

## Host Edges

| Edge | Claude/Codex | Cursor |
|---|---|---|
| Before | PreToolUse | preToolUse |
| After | PostToolUse | postToolUse |
| Brief | UserPromptSubmit | sessionStart |
| Verify | Stop/SubagentStop | stop/subagentStop |
| Finalize | SessionEnd (Claude) / PreCompact (Codex) | sessionEnd/preCompact |

Claude/Codex context uses event-named `hookSpecificOutput`. Cursor uses `additional_context` at session start and `agent_message` around tool use; Cursor stop uses `followup_message`; Claude/Codex stop uses exit 2. Host delivery is best-effort and must be smoked. PreCompact finalizes/captures but keeps the host session reusable. SessionEnd marks the session ended; it does not delete explicit WORK or claim success. Presence/task claim TTLs are independent. Expiry removes stale coordination, never success, and never changes a live TASK run to PENDING.

Guard denial and real exclusivity use the host's native block shape: exit 2 for Claude/Codex and `permission: deny` for Cursor. Infrastructure/input failure warns and fails open.

## Diagnostics & Prompt Delivery

Bounded SQLite upserts report `unverified|observed|stale|failed`, `coverage`, and `last_seen` without payloads. Codex: inspect project trust, definition trust, and feature enablement. Cursor: smoke local/cloud; flat config lacks a guaranteed Windows command override. Smoke: session/subagent registration; ordinary peer context once; exclusive denial before presence; a failed write creates no audit/debt; N successful writes in one turn become one fallback Verify item with N files; PreCompact reuses the session; SessionEnd ends it; changed briefing and host log visibility. Treat any missing edge as a runtime failure even when config is green.

Prompt-time delivery is transient: shell hooks pass an event prompt when available. The hook emits at most one grounded memory lead (or silence), keeps signals/overrides independent, and caps the final five-item packet at 1 KiB UTF-8. Selection/trust: `references/memory-recall.md`.

Harness edits require `OCTOCODE_ALLOW_HARNESS_APPLY=1` plus a safe non-main branch. Pre-edit remains the single ordered guard+presence edge. Tuning/installation above; file decisions: `references/files-awareness.md`.
