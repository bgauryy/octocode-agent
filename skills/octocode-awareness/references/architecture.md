# Awareness Architecture

Load when changing store ownership, host composition, or policy routing. This reference step ends here; return to the main skill flow.

## Shared coordination plane

```text
agent CLI     -> npx @octocodeai/octocode-awareness ┐
host tools/hooks -> package API                     ├-> shared dispatcher -> global agent.sqlite3
other integrations -> package API                   ┘                        (rows scoped by workspace_path)
```

The CLI and in-process API call `dispatchAwarenessCommand`; neither host owns a second command mapping. Awareness tables are `plans`, `tasks`, `locks`, `work_presence`, `handoffs`, `memories`, `agents`, `messages`, and `message_receipts`. Octocode control tables coexist in the file under `@octocodeai/octocode-shared` ownership.

The global agent database stores all durable state. `workspace_path` isolates repository rows, and `--db <path>` selects an explicit isolated store.

## Advanced plane

The same package CLI owns attend/workboard, plan runs, signals, refinements, sessions, reflection, query exports, and maintenance. Stores initialize lazily; use `maintenance init` only when an explicit initialization check is needed.

Every Git worktree has a distinct normalized `workspace_path` inside the shared database.

The CLI boundary uses canonical root nouns. Use `workspace status` for store health, `query <view>` for targeted inspection, and inspect the matching live schema before acting.

## Invariants

- Workspace path scopes shared rows; two repositories may use the same agent id or relative file path safely.
- Reads do not clean up state. Expired rows are filtered/projected; reclaim and pruning are explicit mutations.
- Task completion creates verification debt. Only an observed check receipt proves success.
- Presence is advisory; locks are exceptional exclusivity.
Return to `SKILL.md`. Hooks automate deterministic edges, never task choice or success claims.
