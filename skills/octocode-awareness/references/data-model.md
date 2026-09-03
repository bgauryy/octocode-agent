# Awareness Data Model

Load when changing schemas or interpreting stored entities.

The Awareness schema lives in `<workspace>/.octocode/awareness.sqlite3` by default, or `$OCTOCODE_HOME/awareness/awareness.sqlite3` for explicit global scope. SQLite is canonical. Agent control and runtime databases are separate owners, and other `.octocode/` databases or generated files are not Awareness state.

```text
plan -> task -> claim/run -> run_files (advisory)
                           `-> locks (exclusive)
standalone work ---------> run -> same file/lock model
```

| Family | Tables |
|---|---|
| Plans | `plans`, `plan_members`, `plan_docs` |
| Tasks | `tasks`, `task_paths`, `task_dependencies`, `task_claims`, `task_events` |
| Execution | `task_runs`, `run_files`, `locks`, `run_log`, `edit_log` |
| Delivery | `delivery_state`, `signals`, `signal_reads` |
| Knowledge | `memories`, `memory_refs`, FTS, `refinements`, `harness_log` |
| Presence | `agents`, `sessions` |

Run origin is `TASK|WORK|HOOK`. Task readiness is derived from `OPEN`, no live claim, and completed dependencies. Tasks are the queue; refinements are owned follow-up.

```text
task: OPEN -> IN_PROGRESS -> VERIFY -> DONE|FAILED
                    \-> OPEN|BLOCKED
run:  ACTIVE -> PENDING -> SUCCESS|FAILED
```

`task_runs` owns agent/session/task identity and rationale. `run_files` records advisory paths; `locks` records only exclusive protection; `edit_log` is completed history. Never conflate these layers.

Verification debt is a `PENDING` run. TTL, cleanup, and delivery fingerprints never establish success. Signal reads live in `signal_reads`; memory references preserve provenance.

Inspect public contracts with `schema commands --compact` and `schema json-schema <name>`.

Next: return to `SKILL.md`; use `references/files-awareness.md` for overlap semantics.
