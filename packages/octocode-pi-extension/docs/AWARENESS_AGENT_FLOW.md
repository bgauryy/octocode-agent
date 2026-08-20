# Awareness Lite Agent Flow in Pi

Awareness Lite has one agent-facing interface in Pi: the published CLI invoked as
`npx @octocodeai/octocode-awareness-lite`, guided by the `octocode-awareness-lite` skill.
Coordination is not duplicated as Pi tools.

## Why

One CLI/schema keeps flags, help, other coding agents, and Pi on the same
small SQLite contract. Lite coordination is explicit: the Pi bridge exposes the
Lite skill assets but does not automate full lifecycle hooks or bundle the CLI runtime.

## Identity

- An explicit user `OCTOCODE_AGENT_ID` remains stable.
- Otherwise Pi derives `pi:<session-file>` for the current session.
- Sequential `/new`, `/resume`, and forked sessions refresh the derived identity.
- Hooks and CLI subprocesses inherit that same current identity.
- Spawned Pi workers derive child identities as `<parent>:worker:<short-id>` and record that mapping in the in-session worker ledger (`/octocode-agents`; see [`AGENT_ORCHESTRATOR.md`](./AGENT_ORCHESTRATOR.md)). Durable Awareness writes for raw worker output stay deferred until privacy/storage review accepts them.

## Start

```bash
npx @octocodeai/octocode-awareness-lite status --workspace "$PWD"
```

Inspect plan/task/lock/work counts and pending verification checks. Recalled
memories are leads; verify them against current source/tests.

## Choose work

Claim a matching task:

```bash
npx @octocodeai/octocode-awareness-lite task list --workspace "$PWD" --plan-id plan_123 --status OPEN
npx @octocodeai/octocode-awareness-lite task claim \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID"
```

Or open standalone Work:

```bash
npx @octocodeai/octocode-awareness-lite work start \
  --workspace "$PWD" --agent-id "$OCTOCODE_AGENT_ID" \
  --file src/a.ts --reason "fix parser"
```

Every file edit should belong to a Task or manual Work presence with a reason.
Advisory presence is the default and allows informed overlap. Use `lock acquire`
for sensitive/non-mergeable changes.

## Hooks during edits

Awareness Lite does not wire full Pi lifecycle automation. Pi only runs the Lite
pre-edit lock gate for write tools; agents still coordinate explicitly by running
`task`, `work`, `lock`, `handoff`, and `check` commands through `npx @octocodeai/octocode-awareness-lite`.

## Finish exactly owned work

For a task:

```bash
npx @octocodeai/octocode-awareness-lite task done \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID"
npx @octocodeai/octocode-awareness-lite check mark \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID" \
  --message "parser tests passed"
```

For standalone Work:

```bash
npx @octocodeai/octocode-awareness-lite work end \
  --workspace "$PWD" --file src/a.ts --agent-id "$OCTOCODE_AGENT_ID"
npx @octocodeai/octocode-awareness-lite check audit --workspace "$PWD"
```

Never use a batch success operation to clear another agent’s debt. Verification
records evidence; it does not execute the check.

## Recall and record

Use targeted retrieval only when durable context can change the plan:

```bash
npx @octocodeai/octocode-awareness-lite memory recall \
  --workspace "$PWD" --query "parser regression" --limit 5
```

Record only reusable, verified facts:

```bash
npx @octocodeai/octocode-awareness-lite memory store \
  --workspace "$PWD" --label GOTCHA \
  --text "parser regression: Malformed escapes must be rejected before tokenization"
```

Skip routine status, raw logs, obvious edits, secrets, and facts already captured
in source/docs.

## Handoff

```bash
npx @octocodeai/octocode-awareness-lite handoff list --workspace "$PWD"
npx @octocodeai/octocode-awareness-lite handoff add \
  --workspace "$PWD" --agent-id "$OCTOCODE_AGENT_ID" \
  --summary "Parser task ready; run parser tests before finishing" --file src/parser.ts
```

Use a Plan Task for selectable durable work; handoffs are notes, not a second
task queue.

## Cleanup

Use the same `npx @octocodeai/octocode-awareness-lite` CLI for read-only status and explicit cleanup. Lite has no
maintenance digest or repo projection flow; `memory forget`/`delete` require a
specific `--memory-id`.
