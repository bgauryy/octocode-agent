# Awareness Architecture

Load when changing store ownership, host composition, or policy routing. This reference step ends here; return to the main skill flow.

## Shared coordination plane

```text
agent CLI     -> npx @octocodeai/octocode-awareness ┐
host tools/hooks -> package API                     ├-> shared dispatcher -> awareness.sqlite3
other integrations -> package API                   ┘                        (repo or global scope)
```

The CLI and in-process API call `dispatchAwarenessCommand`; neither host owns a second command mapping. Awareness owns its coordination, planning, work, lock, delivery, memory, session, and worker-observation tables. Shared TypeScript entity contracts do not imply shared physical storage.

Repository scope resolves to `<workspace>/.octocode/awareness.sqlite3`; optional global scope resolves to `$OCTOCODE_HOME/awareness/awareness.sqlite3`. `--db <path>` selects an explicit isolated store. Agent control (`agent.sqlite3`) and Rust runtime (`core.sqlite3`) remain separate Agent-owned databases under `$OCTOCODE_HOME/agent/`.

## Advanced plane

The same package CLI owns attend/workboard, plan runs, signals, refinements, sessions, reflection, query exports, and maintenance. Stores initialize lazily; use `maintenance init` only when an explicit initialization check is needed.

Every Git worktree has its own repository-scoped file by default and still records a normalized `workspace_path` for row-level identity and explicit/global stores.

The CLI boundary uses canonical root nouns. Use `workspace status` for store health, `query <view>` for targeted inspection, and inspect the matching live schema before acting.

## Invariants

- Workspace path scopes shared rows; two repositories may use the same agent id or relative file path safely.
- Reads do not clean up state. Expired rows are filtered/projected; reclaim and pruning are explicit mutations.
- Task completion creates verification debt. Only an observed check receipt proves success.
- Presence is advisory; locks are exceptional exclusivity.
Return to `SKILL.md`. Hooks automate deterministic edges, never task choice or success claims.
