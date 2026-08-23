---
name: octocode-awareness-lite
description: "Use when agents work in parallel in the same repo and must coordinate through octocode-awareness-lite: inspect plans, tasks, locks, manual work presence, handoff notes, check debt, and local memory before/during/after edits; claim tasks, declare touched files with work, lock risky files, verify, and leave concise traces."
---
# Octocode Awareness Lite

Use this skill when multiple agents may be working in the same repository at the
same time and the repo wants lightweight local coordination through
`octocode-awareness-lite`.

The goal is **repo situational awareness**: before editing, during long work, and
before finishing, inspect the shared local SQLite ledger so you know what other
agents planned, claimed, touched, locked, verified, handed off, or remembered.

## Agent bootstrap prompt

If a repo wants Lite coordination, the only prompt an agent should need is:

> Use the `octocode-awareness-lite` skill. Coordinate through the local
> `octocode-awareness-lite` CLI in this repository before editing, during long
> work, and before finishing. Join with one stable agent id, inspect status,
> plans, tasks, work, locks, handoffs, checks, messages, and memory; claim or
> create scoped tasks; declare touched files with `work`; lock only risky files;
> run checks before marking tasks done; record reusable repo memory only when it
> is verified. Install the optional Lite pre-edit hook only when the user or repo
> asks for hook-based lock conflict protection.

There is no required `init` command. The first CLI command creates the local DB at
`<workspace>/.octocode-lite/awareness-lite.sqlite3` unless `--db` is provided.
Install the published skill once in the host if the host does not already discover
it; then trigger it by saying “use skill `octocode-awareness-lite`”.

## Use the lite CLI

Use `octocode-awareness-lite` for this workflow.

During package development prefer the local build:

```bash
node packages/octocode-awareness-lite/out/cli.js <command> --workspace "$PWD"
```

Installed package form:

```bash
octocode-awareness-lite <command> --workspace "$PWD"
```

Do not substitute the full `octocode-awareness` CLI unless the repo needs signal
threads/inbox, hooks, reflection, automated handoff capture, live presence, or the
full memory system.

All commands print JSON. Run `schema` instead of guessing command shapes.

## What lite tracks

All Lite state is local to the repository DB unless `--db` points elsewhere.

- **Plans** — shared work areas with `planId`, title, goal, `OPEN`/`DONE`, and timestamps.
- **Tasks** — claimable work units with `taskId`, `planId`, title, `filePath`/`paths`, dependency readiness, lease fields, `checkCommand`, owner `agentId`, status, done time, and verification receipt fields.
- **Work** — manual advisory file presence; tells peers what files you are touching without blocking them.
- **Locks** — advisory exclusive file claims for sensitive/non-mergeable edits, with wait/prune helpers; the optional hook checks these before writes.
- **Checks** — verification debt; done tasks are not trustworthy until their check receipt is marked.
- **Handoffs** — manual continuation notes with related files; not a signal thread or task queue.
- **Agents** — lightweight identity records (`ACTIVE`, `IDLE`, `LEFT`) for peers sharing one repo DB; `--stale-after` interprets `lastSeenAt` without a daemon.
- **Messages** — tiny per-agent inbox/broadcast notes for active coordination; old messages can be pruned explicitly, dry-run first.
- **Memory** — short repo-local gotchas/decisions that future agents can recall by text, tag, or label; stale memory can be pruned explicitly by age and optional label.
- **Schema** — machine-readable entity and command shapes.

Lite does **not** store git history, diffs, or a semantic repo index. Treat memory,
handoffs, plans, and checks as repo-local coordination history; use `git status`,
diffs, logs, and tests for source-of-truth code history and proof.

Lite has only one optional hook: `hooks pre-edit`, a small lock-conflict gate for
Pi/Claude/Cursor/Codex write tools. It reads the host's write-tool event JSON,
extracts target paths, checks active Lite locks, prints `ok/blocked/conflicts`,
and exits `2` when another agent owns a conflicting lock. It does not auto-record
work, create handoffs, or enforce verification. There is no signal thread,
reflection, bundled embedding service, remote sync, generated docs, or live heartbeat daemon.
Memory can use an optional host-owned `OCTOCODE_EMBED_CMD` for semantic recall,
but Lite does not ship or manage an embedding runtime.
Lite only knows touched files you manually declare with `work`, and stale agents
are only reported from `lastSeenAt`, so always combine it with normal repo
inspection: `git status`, diffs, and tests.

## Continuous awareness loop

Run this loop before edits, after a long pause or major change, and before the
final response:

```bash
octocode-awareness-lite schema --workspace "$PWD"
octocode-awareness-lite status --workspace "$PWD" --stale-after 30m
octocode-awareness-lite plan list --workspace "$PWD"
octocode-awareness-lite task list --workspace "$PWD"
octocode-awareness-lite agent join --workspace "$PWD" --agent-id "$AGENT_ID"
octocode-awareness-lite agent list --workspace "$PWD" --stale-after 30m
octocode-awareness-lite message inbox --workspace "$PWD" --agent-id "$AGENT_ID"
octocode-awareness-lite work list --workspace "$PWD"
octocode-awareness-lite lock list --workspace "$PWD"
octocode-awareness-lite handoff list --workspace "$PWD"
octocode-awareness-lite check audit --workspace "$PWD"
octocode-awareness-lite memory recall --workspace "$PWD" --query "<task topic>"
# Optional host hook installer: dry-run first; it writes .claude/settings.json,
# .cursor/hooks.json, or .codex/hooks.json only when repeated without --dry-run.
octocode-awareness-lite hooks install --workspace "$PWD" --host claude --project-dir "$PWD" --dry-run
```

How to read it:

- `status.pendingChecks > 0`: completed work still lacks proof; do not rely on it blindly.
- `status.work > 0`: inspect overlapping manual file presence.
- `status.staleAgents > 0`: inspect stale peers before assuming their work is still live.
- `status.messages > 0`: check your inbox before deciding; broadcasts are visible to all other agents.
- `status.handoffs > 0`: read continuation notes before deciding.
- `status.memories > 0`: recall relevant gotchas before deciding.
- `task.status = CLAIMED` with another `agentId`: leave that task alone.
- `task ready`: prefer ready tasks; `task claim` will reject dependencies that are not done and verified.
- `task.status = CLAIMED` with an expired lease may become `OPEN` during status/list operations; verify current code/tests before relying on it.
- overlapping `task.filePath`/`task.paths` or `work.filePath`: inspect and coordinate; work presence is advisory, not exclusive.
- overlapping `lock.filePath`: do not edit unless you own the lock, it expired, or you coordinated externally.
- handoffs and memory are hints, not proof; verify against current code/tests.

## Parallel-agent workflow

### 1. Join the repo and read messages

Use one stable `$AGENT_ID` for the whole session. Join once, then read your inbox
before claiming work. Use messages for active peer coordination; use handoffs only
for durable continuation notes.

```bash
octocode-awareness-lite agent join --workspace "$PWD" --agent-id "$AGENT_ID" --name "short name" --role "implementer"
octocode-awareness-lite message inbox --workspace "$PWD" --agent-id "$AGENT_ID"
```

### 2. Choose or create scoped work

Reuse an existing `OPEN`/ready plan task when it matches. Otherwise create a small
task that names the target file(s), acceptance, dependencies, and check command
clearly.

```bash
octocode-awareness-lite plan create --workspace "$PWD" --title "short goal" --goal "why"
octocode-awareness-lite task add --workspace "$PWD" --plan-id plan_... --title "small task" --file path/to/file --path path/to/file,tests/file.test.ts --depends-on task_prev --acceptance "observable done state" --check "yarn test"
octocode-awareness-lite task ready --workspace "$PWD" --plan-id plan_...
octocode-awareness-lite task show --workspace "$PWD" --task-id task_...
```

### 3. Claim before editing

```bash
octocode-awareness-lite task claim --workspace "$PWD" --task-id task_... --agent-id "$AGENT_ID" --lease 1800
octocode-awareness-lite task heartbeat --workspace "$PWD" --task-id task_... --agent-id "$AGENT_ID" --lease 1800
```

If the task belongs to another `agentId` or is blocked by dependencies, stop or
choose different work. If you cannot proceed, release it with context:

```bash
octocode-awareness-lite task release --workspace "$PWD" --task-id task_... --agent-id "$AGENT_ID" --blocked-reason "waiting for review"
```

### 4. Declare touched files with `work`

Use `work` for manual advisory presence whenever you are touching a file. Refresh
it during long sessions with `work start` again or the `touch` alias.

```bash
octocode-awareness-lite work start --workspace "$PWD" --file path/to/file --agent-id "$AGENT_ID" --reason "editing" --ttl 1800
octocode-awareness-lite work touch --workspace "$PWD" --file path/to/file --agent-id "$AGENT_ID" --reason "still editing" --ttl 1800
```

### 5. Lock risky files only when needed

Use `lock` for sensitive paths where simultaneous edits would be hard to merge or
would invalidate each other. If the optional pre-edit hook is installed, it only
blocks writes that conflict with active locks owned by another agent; it does not
replace task claims, `work` presence, or real verification.

```bash
octocode-awareness-lite lock acquire --workspace "$PWD" --file path/to/file --agent-id "$AGENT_ID" --reason "editing" --ttl 1800
octocode-awareness-lite lock wait --workspace "$PWD" --file path/to/file --agent-id "$AGENT_ID" --wait 30s --retry-interval 500ms
```

Optional hook install, when the user or repo asks for hook-based protection:

```bash
octocode-awareness-lite hooks install --workspace "$PWD" --host claude --project-dir "$PWD" --dry-run
# Review the returned JSON/settings path, then repeat without --dry-run to write it.
```

### 6. Refresh awareness during long work

```bash
octocode-awareness-lite task list --workspace "$PWD"
octocode-awareness-lite task ready --workspace "$PWD"
octocode-awareness-lite work list --workspace "$PWD" --agent-id "$AGENT_ID"
octocode-awareness-lite lock list --workspace "$PWD"
octocode-awareness-lite handoff list --workspace "$PWD"
```

If new claimed tasks, work presence, or locks overlap your scope, narrow the
change or coordinate outside lite before continuing.

### 7. Verify before marking done

Run the task's `checkCommand` yourself. Only after it passes should you mark the
task done and record the check receipt.

```bash
octocode-awareness-lite task done --workspace "$PWD" --task-id task_... --agent-id "$AGENT_ID"
octocode-awareness-lite check mark --workspace "$PWD" --task-id task_... --agent-id "$AGENT_ID" --message "yarn test passed" --status SUCCESS
octocode-awareness-lite check audit --workspace "$PWD" --agent-id "$AGENT_ID"
```

If a check fails or later evidence shows the task is incomplete, mark the check
failed (which reopens the task with the failure reason) or reopen it explicitly:

```bash
octocode-awareness-lite check mark --workspace "$PWD" --task-id task_... --agent-id "$AGENT_ID" --message "check failed" --status FAILED
octocode-awareness-lite task reopen --workspace "$PWD" --task-id task_... --agent-id "$AGENT_ID" --reason "check failed"
```

### 8. Leave handoffs only when useful

Use `handoff` when another agent needs compact continuation context. Do not use it
as a chat log, inbox, signal thread, or duplicate task queue.

```bash
octocode-awareness-lite handoff add --workspace "$PWD" --agent-id "$AGENT_ID" --summary "what remains / current state" --file path/to/file,other/file
octocode-awareness-lite handoff list --workspace "$PWD"
octocode-awareness-lite handoff clear --workspace "$PWD" --handoff-id handoff_...
```

### 9. Maintain memory carefully

Store memory only when it is reusable for future agents in this repo: verified
gotchas, command quirks, repo conventions, or decisions. Never store secrets, raw
logs, one-off status, or unverified guesses.

```bash
octocode-awareness-lite memory store --workspace "$PWD" --label GOTCHA --text "short reusable learning" --tags area,topic
octocode-awareness-lite memory recall --workspace "$PWD" --query "area"
octocode-awareness-lite memory forget --workspace "$PWD" --memory-id mem_...
octocode-awareness-lite memory prune --workspace "$PWD" --older-than 90d --label GOTCHA          # dry-run
octocode-awareness-lite memory prune --workspace "$PWD" --older-than 90d --label GOTCHA --confirm
```

### 10. Prune old local chatter only after reviewing

Pruning is manual and dry-run by default. Use it for old coordination noise, not
as a substitute for task/check cleanup.

```bash
octocode-awareness-lite message prune --workspace "$PWD" --older-than 30d --read-only          # dry-run
octocode-awareness-lite message prune --workspace "$PWD" --older-than 30d --read-only --confirm
octocode-awareness-lite lock prune --workspace "$PWD"                                      # dry-run
octocode-awareness-lite lock prune --workspace "$PWD" --confirm
```

### 11. Close cleanly

Before final response, run the awareness loop again. Then close only the work you
actually verified, release locks you own, end work presence you own, and leave the
plan open if more tasks remain.

```bash
octocode-awareness-lite check audit --workspace "$PWD"
octocode-awareness-lite plan done --workspace "$PWD" --plan-id plan_...
octocode-awareness-lite work end --workspace "$PWD" --file path/to/file --agent-id "$AGENT_ID"
octocode-awareness-lite lock release --workspace "$PWD" --file path/to/file --agent-id "$AGENT_ID"
```

Conclude only when your task is verified and no relevant pending check debt
remains. A plan may stay `OPEN` if other tasks are intentionally left for later.

## Conflict rules

- Do not edit a locked file unless you own the lock, it expired, or you coordinated externally.
- Do not ignore overlapping `work` presence; inspect and coordinate even though it is not exclusive.
- Do not claim, complete, or verify another agent's task.
- Do not mark checks for commands you did not run.
- Do not hide failed checks; use `task reopen` or leave audit pending.
- Do not use `handoff` as an inbox, signal thread, or duplicate task queue.
- Do not treat handoffs or memory as truth without checking current code/tests.
- Use full `octocode-awareness` instead when you need signal threads/inbox, hooks, reflection, automated handoff capture, or live presence.
