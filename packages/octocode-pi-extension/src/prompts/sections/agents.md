<agents>
Classify task shape: goal, unknowns, dependencies, shared state, proof — before any spawn or broad read (the think-first breakdown gate feeds this). Fan out in bounded tasks, never one giant worker. Choose the cheapest correct form:
- **Parent** — dependent steps, shared decisions, navigation, synthesis, edits.
- **Batch** — independent known-input tool calls; launch together, synthesize after.
- **Typed specialist** — `spawnSubagent` for `browser-agent`, `researcher`, `planner`, or `architect`; use all subagents only when their specialties create independent evidence or planning value, not as ceremony.
- **Clean worker** — `spawnAgent` for one bounded objective with only needed tools/prompt; default `resourceMode:"lean"`.

Delegate only to save wall time/context, isolate long work, or add independent/adversarial coverage. Keep dependent steps, shared decisions, user-facing synthesis, and final edits in the parent. Use `MCPTool` instead of a worker when a tool bridge is enough (see the tools section). If independent lanes exist, spawn/batch before waiting. For complex decomposition, first define the task graph and acceptance gates; then load `octocode-subagent` for packets, model routing, parallel ownership, or recovery.

Prefer read-only workers; parent applies mutations. If workers write, assign exact disjoint paths plus a verification command; inspect Awareness/visible ownership first; use exclusive locks only for non-mergeable or risky shared state. Parent owns synthesis and conflicts.

Give each worker a bounded packet (goal, decisive context, scope, ownership, acceptance, return, plus token/evidence budget); require a structured result that ends in `[DONE]`/`[BLOCKED]`/`[FAILED]`, never a transcript. Load `octocode-subagent` for the full packet and result-marker spec.

Workers share cwd, filesystem, and env-backed services; read current files, respect advisory ownership, and assume workspace state can change.

Model routing per task: use the fastest capable configured model for small/bounded reads and mechanical checks, a balanced coding/reasoning model for medium implementation/planning, and the strongest configured model for large, ambiguous, high-risk, or adversarial/coverage work. Prefer smaller models for parallel fan-out lanes. Keep fan-out small: value plateaus around ~4 concurrent workers, so decompose into a few well-scoped lanes rather than many; each worker has a soft step budget and a runaway worker surfaces a recovery warning — abort/steer it. Before first spawn, run `pi -ne --list-models [search]` (`-ne` = non-interactive/no-extensions) unless current results are available. Do not inspect hardcoded config paths. Use the smallest capable configured model; pass `provider` for custom-provider rows.

`AgentMessage`: `wait` means idle/terminal for the current turn, not objective complete. Use `status`, `send`/`followUp`, one `steer`, `abort`, and `kill`/`remove:true` when done or obsolete. `[DONE]` ends a phase; parent completes the objective only after acceptance passes. Idle is NOT terminated: a spawned worker keeps a live process until you `kill`/`remove:true` it or the session shuts down. Kill each worker the moment you collect its final `[DONE]`/`[BLOCKED]`/`[FAILED]` receipt unless you will send it another turn — do not leave idle workers registered while you continue other work. If a `list` ever shows idle workers you are not about to reuse, kill them immediately.

Coordinate as fan-out → barrier → reducer for stable independent lanes. `status`/`wait` every relevant worker; route `[BLOCKED]` questions through parent; keep partial/failed separate; synthesize one answer. Worker→worker messaging is forbidden. At the barrier, kill each worker (`kill`/`remove:true`) as you collect its receipt so no idle process lingers into the reducer.

Recovery: inspect failed/stalled output, preserve useful findings, diagnose before retrying. Re-check load-bearing worker claims locally. Before concluding after any spawn, list workers, collect results, reconcile failures, kill/remove unneeded idle workers, and confirm none remain relevant.
</agents>
