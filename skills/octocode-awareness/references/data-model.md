# Awareness Data Model

Canonical DB: `~/.octocode/memory/awareness.sqlite3` (or `$OCTOCODE_MEMORY_HOME/awareness.sqlite3`), schema v1. Generated `.octocode/` files are query snapshots, not operational state.

```text
plan -> tasks -> one claim/run -> run_files (advisory)
                              `-> locks (exclusive)
standalone work -> explicit WORK run -> same file/lock model
```

## Tables

| Family | Tables |
|---|---|
| Plans | `plans`, `plan_members`, `plan_docs` |
| Tasks | `tasks`, `task_paths`, `task_dependencies`, `task_claims`, `task_events` |
| Execution | `task_runs`, `run_files`, `locks`, `run_log`, `edit_log` |
| Delivery | `delivery_state`, `signals`, `signal_reads` |
| Knowledge | `memories`, `memory_refs`, FTS, `refinements`, `harness_log` |
| Presence | `agents`, `sessions` |

Run origin is `TASK|WORK|HOOK`. Readiness is derived: `OPEN` + no live claim + all dependencies `DONE`. Tasks are the only queue; refinements are owned follow-up.

## Entities

`plans` stores objective, lead, status, scope, and plan folder; members participate; docs register `PLAN.md`.
`tasks` stores durable work: reasoning/acceptance, planning paths, priority, status, and dependency graph. `task_claims` leases one agent/run; there is no READY row or second task list.
`task_runs` stores one attempt with origin, agent/session, rationale, test plan, scope, and `ACTIVE|PENDING|SUCCESS|FAILED` status.
`run_files` stores `(run_id,file_path)`, optional reason override, heartbeat, expiry, and end time — mandatory advisory "under work" state.
`locks` stores only exclusive `(run,path)` protection. `edit_log` is completed edit history.

```text
task: OPEN -> IN_PROGRESS -> VERIFY -> DONE|FAILED
                    \-> OPEN|BLOCKED
run:  ACTIVE -> PENDING -> SUCCESS|FAILED
```

`delivery_state` suppresses unchanged prompt delivery. Memories store reusable learning; signals store peer threads; refinements store owned follow-up; sessions group host activity. Agent identity is cooperative, not security.

## Ownership & Joins

| Owner | Dependents |
|---|---|
| `plans` | `plan_members`, `plan_docs`, `tasks` |
| `tasks` | `task_paths`, `task_dependencies`, `task_claims`, `task_events`, `task_runs` |
| `task_runs` | `run_files`, `locks`, `run_log`, `edit_log`, `harness_log` |
| agents | sessions, plans, claims, runs, signals, memories |
| `signals`/`memories` | `signal_reads`/`memory_refs` |

Active file work:
```sql
SELECT rf.file_path, r.run_id, r.agent_id, r.task_id, r.rationale
FROM run_files rf JOIN task_runs r ON r.run_id = rf.run_id
WHERE rf.ended_at IS NULL AND rf.expires_at > ? AND r.status = 'ACTIVE';
```

Exclusive state is `EXISTS locks(run_id,file_path)`. Reason display is `reason_override`, else task/run reasoning. Plan/task/agent/session are always joined through `task_runs`, never copied into `run_files` or `locks`.

Verification debt is `task_runs.status='PENDING'`; linked task completion follows `verify mark`. `delivery_state` fingerprints output only; signal read state remains in `signal_reads`.

Inspect public operation contracts with `schema commands --compact` and `schema json-schema <name>`.
