# Awareness Flow Matrix

Use this when the next action is unclear. Pick the smallest matching row, run `attend` first, and load the deeper reference only if the row does not give enough detail.

| Trigger | Do | Verify / close | Deeper reference |
|---|---|---|---|
| Start any repo task | `attend --workspace "$PWD" --query "<task>" --agent-id "$OCTOCODE_AGENT_ID" --compact`; follow `next` | State goal, scope, acceptance, expected check | `agent-cheatsheet.md` |
| Matching ready shared task | `task claim --task-id <task> --agent-id "$OCTOCODE_AGENT_ID" --compact`; declare files with hooks or `work start --run-id <run>` | Run acceptance while present, then `task submit` + `verify mark` | `plan-task-workflow.md` |
| No shared task / solo edit | `work start --agent-id "$OCTOCODE_AGENT_ID" --workspace "$PWD" --file <path> --rationale "<why>" --test-plan "<check>" --compact` | Run check, `work end`, `verify mark`, `verify audit` | `plan-task-workflow.md` |
| Peer already on same file | Continue only if independent; otherwise `work show --file <path>` and coordinate with `signal publish` | Resolve/ack signal after action; keep verification separate | `files-awareness.md`, `coordination-protocol.md` |
| Unsafe/non-mergeable file | Prefer `work start --exclusive`; use `lock acquire` only for task/run-aware recovery | Exit `2` means wait/signal/switch; expiry never means success | `lock-protocol.md` |
| Inbox/blocker/question/handoff | `signal list --agent-id "$OCTOCODE_AGENT_ID" --workspace "$PWD" --limit 3 --compact`; reply/ack/resolve in same thread | Close when acted or explicitly declined | `coordination-protocol.md` |
| Prior lesson may change plan | `memory recall --query "<task>" --workspace "$PWD" --smart --compact` | Verify current source/tests before trusting; supersede stale rows | `memory-recall.md` |
| Need exact flags/schema | `schema command <noun> [action] --compact`; for direct nouns use `schema command attend --compact` | Use command examples; do not preload full inventory | `output-routing.md` |
| Bulk human inspection | `query all --workspace "$PWD" --format html --out .octocode/awareness/index.html` | Treat export as read-only snapshot, not canonical state | `output-routing.md` |
| Hooks/host setup or drift | Preview install/remove; then `hooks check --host <host> --strict`; smoke real host edges | Config green is not runtime proof | `hooks.md` |
| Verified reusable learning | `reflect record --lesson ...` or route `--fix-repo|--fix-harness|--fix-instructions` | Apply owner action, verify, close refinement/review row | `learning-loop.md` |
| Finish / before handoff | `verify audit --workspace "$PWD" --agent-id "$OCTOCODE_AGENT_ID" --compact`; if pressure, `maintenance digest --dry-run --compact` | Pending gets SUCCESS/FAILED from real check; stale ACTIVE can only be FAILED | `agent-cheatsheet.md`, `learning-loop.md` |

Rules of thumb:
- SQLite/CLI is canonical; `.octocode/` exports and plan docs are not live state.
- Hooks automate deterministic edges only; agents still choose goals, locks, verification, learning, and cleanup.
- Open exactly one deeper reference for the current row instead of reading the whole skill pack.
