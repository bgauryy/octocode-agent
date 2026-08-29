# Orchestration Contract

Load when FRAME or DECOMPOSE needs an explicit goal, graph, ownership, or critical path. Why: orchestration without a bounded contract optimizes activity instead of the user's outcome.

## Frame

- Restate one user-visible goal and observable done condition.
- Record scope, exclusions, authority, risky actions requiring approval, and environment constraints.
- Name one primary outcome measure plus guardrails; ordinary tasks may use focused tests as the sensor.
- Set an aggregate time, token, tool-call, and worker budget when delegation or evals can materially expand cost.
- Identify the parent-owned critical path: user decisions, integration, irreversible actions, and final evidence.

## Decompose

Write nodes as `verb → output`, then mark `blocks`, `feeds`, or `conflicts` edges. A node is independently delegable only when its inputs are known, its writes are disjoint or read-only, and its result has a mergeable return shape.

If every node reads the previous node's evolving output, keep a sequential parent loop. If two or more nodes are independent and delegation materially helps, choose a bounded graph. Prefer the smallest graph that can satisfy acceptance.

Keep fixed classifications, sequences, gates, retries, and stopping conditions in deterministic parent logic. Use an agent node only where inputs cannot fully determine the route or where independent judgment has measurable value.

## Working plan

For each node record owner, inputs, outputs, dependencies, edit paths, verification command, and status. Keep at most one parent step in progress; workers may run concurrently only across independent nodes.

Next: load [delegation](delegation.md) for worker packets, or [evaluation](evaluation.md) to freeze the measurable contract before mutation.
