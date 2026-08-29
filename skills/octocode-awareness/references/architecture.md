# Awareness Architecture

Load when changing store ownership, host composition, or policy routing. This reference step ends here; return to the main skill flow.

## Shared coordination plane

```text
agent CLI     -> npx @octocodeai/octocode-awareness ┐
host tools/hooks -> package API                     ├-> shared dispatcher -> selected octocode.sqlite3
other integrations -> package API                   ┘                        (rows scoped by workspace_path)
```

The CLI and in-process API call `dispatchAwarenessCommand`; neither host owns a second command mapping. Awareness tables are `plans`, `tasks`, `locks`, `work_presence`, `handoffs`, `memories`, `agents`, `messages`, and `message_receipts`. Octocode control tables coexist in the file under `@octocodeai/octocode-shared` ownership.

Workspace policy defaults shared coordination to
`<workspace>/.octocode/octocode.sqlite3`; reusable memory stays global. `--db-scope`
overrides one call and `--db <path>` overrides both. The policy is a routing façade, not a
schema merge.

## Advanced plane

The same package CLI owns attend/workboard, plan runs, signals, refinements, sessions, reflection, query exports, and maintenance. Repository scope uses `<workspace>/.octocode/awareness.sqlite3`; global scope uses `$OCTOCODE_MEMORY_HOME/awareness.sqlite3`, normally below `$OCTOCODE_HOME/memory/`. Both use the advanced OCT1 schema. Run `npx @octocodeai/octocode-awareness init --compact` for the selected level. Use these commands only for advanced features, not shared coordination.

Prefer repository scope for operational state tied to one checkout. Prefer global scope
for cross-repository memory, maintenance, registry, and machine-level control. Each Git
worktree has an independent repository database.

The CLI boundary is explicit: shared commands are prefixed with `coordination`, except the documented direct shortcuts; advanced commands use root nouns. Direct `status` is shared, while `workspace status` is advanced. Inspect the matching live schema before acting.

## Invariants

- Workspace path scopes shared rows; two repositories may use the same agent id or relative file path safely.
- Reads do not clean up state. Expired rows are filtered/projected; reclaim and pruning are explicit mutations.
- Task completion creates verification debt. Only an observed check receipt proves success.
- Presence is advisory; locks are exceptional exclusivity.
Return to `SKILL.md`. Hooks automate deterministic edges, never task choice or success claims.
