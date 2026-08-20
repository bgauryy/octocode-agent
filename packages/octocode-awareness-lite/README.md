# Octocode Awareness Lite

<div align="center">
<img src="./assets/logo.png" width="200px" alt="Octocode + Pi">
</div>

Tiny local coordination for coding agents. It keeps only the parts that are hard
to fake in chat:

- a local SQLite database;
- Plans;
- Tasks;
- Locks;
- Manual advisory work presence;
- Manual handoff notes;
- Agent registry and a tiny message inbox;
- Check receipts for done tasks;
- Local memory store/recall.

That is it. Lite stores repo-local coordination history, not git history, diffs,
or a semantic repo index. Agents should pair it with normal source-of-truth checks
such as `git status`, diffs, logs, and tests. No signal threads, reflection, docs
catalog, maintenance loop, embeddings, or projections. The only optional hook is
a small pre-edit lock-conflict gate for Pi/Claude/Cursor/Codex write tools.

## Install / run

Requires Node 22.13+ for `node:sqlite`.

```bash
npx @octocodeai/octocode-awareness-lite status --workspace "$PWD"
```

There is no required init step. The first command creates the local DB. Install
or expose `skills/octocode-awareness-lite/` to the agent host once, then the
repo-level prompt can be as small as:

> Use skill `octocode-awareness-lite`. Use the local `octocode-awareness-lite`
> CLI in this repo before edits, during long work, and before final response.
> Join with a stable agent id, inspect status/tasks/work/locks/messages/memory,
> claim or create scoped tasks, declare touched files with `work`, lock only risky
> files, run checks before marking done, and record only verified reusable memory.
> Install the optional Lite pre-edit hook only when hook-based lock protection is
> desired.

By default the database is created at:

```text
<workspace>/.octocode-lite/awareness-lite.sqlite3
```

Override it with `--db /path/to/file.sqlite3`.

## CLI

```bash
octocode-awareness-lite status --stale-after 30m
octocode-awareness-lite schema

octocode-awareness-lite plan create --title "ship auth" --goal "make login production ready"
octocode-awareness-lite plan list
octocode-awareness-lite plan done --plan-id plan_...

octocode-awareness-lite task add --plan-id plan_... --title "fix token refresh" --file src/auth.ts --check "yarn test"
octocode-awareness-lite task list --plan-id plan_...
octocode-awareness-lite task claim --task-id task_... --agent-id agent-a
octocode-awareness-lite task done --task-id task_... --agent-id agent-a
octocode-awareness-lite task reopen --task-id task_... --agent-id agent-a --reason "check failed"

# After running the task's check command:
octocode-awareness-lite check audit
octocode-awareness-lite check mark --task-id task_... --agent-id agent-a --message "yarn test passed"

octocode-awareness-lite lock acquire --file src/auth.ts --agent-id agent-a --reason "editing token refresh"
octocode-awareness-lite lock list
octocode-awareness-lite lock release --file src/auth.ts --agent-id agent-a

octocode-awareness-lite work start --file src/auth.ts --agent-id agent-a --reason "editing token refresh"
octocode-awareness-lite work list
octocode-awareness-lite work end --file src/auth.ts --agent-id agent-a

octocode-awareness-lite handoff add --agent-id agent-a --summary "continue auth docs" --file src/auth.ts,README.md
octocode-awareness-lite handoff list
octocode-awareness-lite handoff clear --handoff-id handoff_...

octocode-awareness-lite agent join --agent-id agent-a --name "Agent A" --role implementer
octocode-awareness-lite agent list --stale-after 30m
octocode-awareness-lite message send --from agent-a --to agent-b --topic review --text "please check auth" --file src/auth.ts
octocode-awareness-lite message inbox --agent-id agent-b
octocode-awareness-lite message read --message-id msg_... --agent-id agent-b
octocode-awareness-lite message prune --older-than 30d --read-only       # dry-run
octocode-awareness-lite message prune --older-than 30d --read-only --confirm

octocode-awareness-lite memory store --label GOTCHA --text "Use node:sqlite on Node 22.13+" --tags sqlite,node
octocode-awareness-lite memory recall --query sqlite
octocode-awareness-lite memory forget --memory-id mem_...
octocode-awareness-lite memory prune --older-than 90d --label GOTCHA       # dry-run
octocode-awareness-lite memory prune --older-than 90d --label GOTCHA --confirm

# Optional: install only the Lite pre-edit lock gate for another host.
# Dry-run first: it prints the settings path, merged hook JSON, and command.
octocode-awareness-lite hooks install --host claude --project-dir "$PWD" --dry-run
octocode-awareness-lite hooks install --host cursor --project-dir "$PWD" --dry-run
octocode-awareness-lite hooks install --host codex --project-dir "$PWD" --dry-run

# After reviewing the JSON, repeat without --dry-run to write one file:
#   claude -> .claude/settings.json
#   cursor -> .cursor/hooks.json
#   codex  -> .codex/hooks.json
octocode-awareness-lite hooks install --host claude --project-dir "$PWD"
```

All commands print compact JSON. `hooks pre-edit` reads a write-tool event as JSON
from stdin or `--event-json`, checks target files against active Lite locks, prints
`ok/blocked/conflicts`, and exits `2` when another agent owns a conflicting lock.

## Library

```ts
import { openAwarenessLite } from '@octocodeai/octocode-awareness-lite';

const aw = openAwarenessLite({ workspace: process.cwd() });
aw.joinAgent({ agentId: 'agent-a', name: 'Agent A', role: 'implementer' });
const plan = aw.createPlan({ title: 'ship auth' });
const task = aw.addTask({ planId: plan.planId, title: 'fix token refresh' });
aw.claimTask({ taskId: task.taskId, agentId: 'agent-a' });
aw.sendMessage({ fromAgentId: 'agent-a', toAgentId: 'agent-b', topic: 'review', text: 'ready for review' });
aw.close();
```

## Agent workflow

A tiny skill is published under `skills/octocode-awareness-lite/`. Load it when an
agent should coordinate through lite instead of the full Awareness system.

The skill teaches agents the approach: use the local DB as a shared coordination
ledger, not as proof of code truth; inspect peers before editing; keep task claims
small; declare manual work presence; use locks only for non-mergeable risk; verify
with real checks; and preserve only useful repo memory.

1. `schema` when unsure about commands/entities.
2. `status --stale-after 30m` to find the DB, pending checks, and stale active agents.
3. `agent join --agent-id <id>` so peers can identify you, then check `message inbox --agent-id <id>`.
4. `memory recall --query <topic>` for local gotchas.
5. Create or choose a plan.
6. Add tasks with `--check`, claim one task, and start `work` presence for files you are touching.
7. Acquire `lock`s only for files where parallel edits would be unsafe.
8. Use `message send` for active peer coordination and `handoff add` only for durable continuation notes.
9. Do the work; refresh `work start`/`touch` during long sessions.
10. Run the task's check command.
11. `task done`, then `check mark` with the command result.
12. If a check fails later, use `task reopen --reason <why>`.
13. Store reusable local learnings with `memory store`; remove stale ones with `memory forget` or dry-run `memory prune --older-than ...` before `--confirm`.
14. Dry-run `message prune --older-than ...` for old coordination noise, then repeat with `--confirm` only when the matches are safe to delete.
15. `check audit` must report `ok: true`, then `plan done`, before concluding.

## Boundaries

`work` is manual advisory presence: it tells other agents which files you are
actively touching, without blocking them. Expired `work` and `lock` rows are
pruned opportunistically when listed; agents are not auto-expired, but
`status --stale-after` and `agent list --stale-after` report stale active peers
from `lastSeenAt`. `lock` is the stronger advisory exclusive claim for sensitive
files. `handoff` is a simple note, not an inbox or signal thread. Memory and
message pruning is explicit and dry-run by default; add `--confirm` to delete.

Keep future additions boring and local. JSON import/export may be useful for
debugging, but do not add signal threads/inbox, lifecycle hooks beyond the
pre-edit lock gate, reflection, generated docs, embeddings, or remote sync here.
