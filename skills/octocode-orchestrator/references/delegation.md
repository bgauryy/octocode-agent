# Delegation

Load when ROUTE is considering or managing a subagent. Why: delegation must earn its coordination cost and preserve attribution.

## Spawn gate

Spawn only for independent parallel width, specialist expertise, clean-context isolation, or fresh verification. Batch known independent tool calls; keep dependent edits and synthesis in the parent. Default to at most five workers and never exceed the host limit; larger or nested graphs need explicit user direction and a new value/cost check.

Use parent-managed workers for bounded subtasks. Use a user-facing handoff only when the user explicitly wants the specialist to own the remainder of the turn and the host supports it. Forward minimum decisive context, define a return or fallback, and re-check authorization before any effect.

## Worker packet

Every request includes:

- goal and decisive context anchors;
- in-scope and excluded work, least-capability tools, source/evidence policy, stop conditions, and authority;
- worker and graph time/token/tool-call budget plus the replan threshold;
- allowed effects; workers cannot seek broader permission, approve their own effects, or exceed parent authority;
- read-only or disjoint write ownership plus verification command;
- observable acceptance criteria;
- return shape: `status`, `result`, up to eight evidence anchors, `verification`, `confidence`, and `next`.

Spawn independent workers before waiting. Steer once if a worker drifts; otherwise stop and replan. Workers do not communicate with the user unless an explicit handoff transfers that role.

## Barrier and merge

List and wait for every needed worker. Stop unused workers. Keep `partial` and `blocked` visible, resolve conflicts first, and recheck load-bearing evidence in the parent. A verifier receives the artifact and acceptance contract, not the executor's reasoning transcript. Majority agreement is not corroboration: vary scope, prompt, or evidence lane where practical and preserve decisive dissent.

Next: load [evaluation](evaluation.md) when the graph needs a frozen KPI, or [completion](completion.md) before synthesis.
