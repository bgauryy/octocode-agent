# Awareness Architecture

## Shared coordination plane

```text
external agent -> octocode-awareness CLI ┐
Pi tools/hooks -> @octocodeai/octocode-awareness ├-> shared dispatcher -> ~/.octocode/octocode.sqlite3
other hosts   -> package root API             ┘                           (rows scoped by workspace_path)
```

The CLI and in-process API call `dispatchAwarenessCommand`; neither host owns a second command mapping. Awareness tables are `plans`, `tasks`, `locks`, `work_presence`, `handoffs`, `memories`, `agents`, `messages`, and `message_receipts`. Octocode control tables coexist in the file under `@octocodeai/octocode-shared` ownership.

`<workspace>/.octocode/` contains authored workspace material such as `REFLECT.md`; it is not the database. `~/.octocode/` (or `OCTOCODE_HOME`) is global Octocode home state.

## Advanced plane

The full `octocode-awareness` CLI owns attend/workboard, plan runs, signals, refinements, sessions, reflection, query exports, and maintenance. It currently uses `~/.octocode/memory/awareness.sqlite3` with a different schema. Use it only for those advanced features, not Pi-visible coordination.

## Invariants

- Workspace path scopes shared rows; two repositories may use the same agent id or relative file path safely.
- Reads do not clean up state. Expired rows are filtered/projected; reclaim and pruning are explicit mutations.
- Task completion creates verification debt. Only an observed check receipt proves success.
- Presence is advisory; locks are exceptional exclusivity.
- Hooks automate deterministic edges, never task choice or success claims.
