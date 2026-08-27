# Awareness Architecture

## Shared coordination plane

```text
agent CLI     -> npx @octocodeai/octocode-awareness ┐
host tools/hooks -> package API                     ├-> shared dispatcher -> ~/.octocode/octocode.sqlite3
other integrations -> package API                   ┘                        (rows scoped by workspace_path)
```

The CLI and in-process API call `dispatchAwarenessCommand`; neither host owns a second command mapping. Awareness tables are `plans`, `tasks`, `locks`, `work_presence`, `handoffs`, `memories`, `agents`, `messages`, and `message_receipts`. Octocode control tables coexist in the file under `@octocodeai/octocode-shared` ownership.

`<workspace>/.octocode/` contains authored workspace material such as `REFLECT.md`; it is not the database. `~/.octocode/` (or `OCTOCODE_HOME`) is global Octocode home state.

## Advanced plane

The same package CLI owns attend/workboard, plan runs, signals, refinements, sessions, reflection, query exports, and maintenance. It currently uses `~/.octocode/memory/awareness.sqlite3` with a different schema. Run `npx @octocodeai/octocode-awareness init --compact` once for this plane. Use these commands only for advanced features, not shared coordination.

The CLI boundary is explicit: shared commands are prefixed with `coordination`, except the documented direct shortcuts; advanced commands use root nouns. Direct `status` is shared, while `workspace status` is advanced. Inspect the matching live schema before acting.

## Invariants

- Workspace path scopes shared rows; two repositories may use the same agent id or relative file path safely.
- Reads do not clean up state. Expired rows are filtered/projected; reclaim and pruning are explicit mutations.
- Task completion creates verification debt. Only an observed check receipt proves success.
- Presence is advisory; locks are exceptional exclusivity.
- Hooks automate deterministic edges, never task choice or success claims.
