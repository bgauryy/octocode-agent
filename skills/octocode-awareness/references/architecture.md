# Awareness Architecture

```text
agent lobby -> CLI / hooks / Pi bridge -> runtime -> global awareness.sqlite3
                                                   |-> live views
                                                   `-> optional query exports -> .octocode/
```

SQLite is canonical and scoped. Generated `.octocode/` files are leads; managed
`.octocode/plan/**` narrative is authored, while live tasks remain in SQLite.
Use live DB timestamps, not projection mtime alone.

## Collaboration Core

```text
plan -> task -> task run -> advisory run files
                         `-> optional exclusive locks
standalone work -> explicit WORK run -> same file/lock model
```

Tasks are the only durable queue. Runs are attempts. File work is mandatory and
non-blocking by default. Locks are exclusive safety for sensitive work. Edit log is
completed-event history.

## Owners

| Need | Reference/surface |
|---|---|
| Start/commands | `references/agent-cheatsheet.md`; `schema commands` |
| Plan/task choice | `references/plan-task-workflow.md` |
| File overlap | `references/files-awareness.md` |
| Exclusive/verify | `references/lock-protocol.md` |
| Signals/refinements | `references/coordination-protocol.md` |
| Hooks/hosts | `references/hooks.md` |
| Tables/joins | `references/data-model.md` |
| Live/durable/generated output | `references/output-routing.md` |
| Memory | `references/memory-recall.md` |
| Learn/clean/skill-evo | `references/learning-loop.md` |
| Homeostasis/drive/duck | `references/homeostatic-loop.md` |

## Session Observability

Compare run-file heartbeat/expiry, locks, task claims, row updates, and file mtimes.

| Question | Read |
|---|---|
| Active peers | `work list\|show` |
| Plans/tasks/runs/locks | `workspace status`, workboard |
| Missing references | `query files` |
| Verification debt | `verify audit` |
| Human cross-view | `query all --format html` |
| Cleanup impact | `maintenance digest --dry-run` |

`session capture` publishes a broadcast `kind=handoff` signal from unresolved work and
dirty files — any next agent in the workspace sees it. Content fingerprinting prevents
repeated SessionEnd/PreCompact events from duplicating the same handoff.

Claude uses SessionEnd; Codex uses PreCompact; Cursor uses sessionEnd/preCompact; Pi
uses shutdown/pre-compact. Hooks fail open — capture manually before a risky handoff.

A host session is not a work-unit boundary. Task claim or explicit `work start` defines
run reuse. Close a handoff by applying/verifying its action, then
`signal resolve --signal-id <id>`. Stale open handoffs auto-resolve after the digest
retention window.

Collision decisions: `references/files-awareness.md`; output choice: `references/output-routing.md`.

## Context Rule

Persist complete coordination; prompt only changes. Ordinary hooks are silent,
peer/briefing delivery is fingerprinted, compact rows are capped, and bulk data uses
query CSV/HTML rather than prompt expansion.

Use `docs show <name>` for one focused owner. Never copy the full command map into
memory or docs; discover it from the schema.
