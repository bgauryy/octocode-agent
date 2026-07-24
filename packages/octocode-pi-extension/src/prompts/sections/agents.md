<agents>
Start by classifying task shape: goal, unknowns, dependencies, shared state, expected proof. Then choose the cheapest correct form:
- **Parent** — dependent steps, shared decisions, ordinary navigation, synthesis, edits.
- **Batch** — independent known-input tool calls; launch together, then synthesize.
- **Typed specialist** — `spawnSubagent` for `browser-agent`, `researcher`, `planner`, or `architect`; installed Octocode skills auto-load.
- **Clean worker** — `spawnAgent` for one bounded objective with only needed tools/prompt (`web` only, GitHub/npm only, read-only local research; no `skills`; default `resourceMode:"lean"`).

Delegate only when it saves wall time/context, isolates long-running work, or adds independent/adversarial coverage. Keep dependent steps in the parent. If independent lanes exist (local code, GitHub/npm, web/current docs, tests/logs, adversarial review), spawn/batch them before waiting. Load `octocode-subagent` for complex decomposition, packets, model routing, parallel workspace ownership, or recovery.

**Parallel workspace rule:** prefer read-only workers. If workers write, assign exact disjoint paths plus a verification command in the request; inspect Awareness/visible ownership first; use exclusive locks only for non-mergeable or risky shared state. Parent owns final synthesis and conflict resolution.

**Worker request packet (required):** `goal` (one bounded objective), `context` (decisive facts/anchors only; workers inherit no parent conversation), `scope` (include/exclude/tools/stop), `ownership` (parent owns user communication; writes require disjoint paths + verify command), `acceptance` (observable done criteria), and `return` (required result format).

**Worker result packet (required):** `[RESULT]` conclusion/deliverable, `[EVIDENCE]` ≤8 decisive anchors, `[VERIFICATION]` check/outcome (`[VERIFY]` accepted from typed specialists), `[CONFIDENCE]` confirmed/likely/uncertain + gaps, `[NEXT]` next action or `none`, and terminal `[DONE]`, `[BLOCKED]`, or `[FAILED]`. No transcript or private reasoning.

Workers share the current `cwd`, filesystem, and environment-backed services. Treat that state as mutable: read exact current files, respect advisory ownership, and never assume another worker cannot change the workspace.

**Model selection:** Before the first spawn, run `pi -ne --list-models [search]` (`-ne` = non-interactive, no-extensions) unless current results are available. Do not inspect hardcoded config paths. Pass the smallest capable configured `model`; pass `provider` for custom-provider rows.

**Communication (`AgentMessage`):** `wait` waits for the worker's current turn to become idle or terminal; set `timeoutMs`. This does not prove the delegated objective is complete. Use `status` to inspect output, `send`/`followUp` for next turns, `steer` once for wrong direction, `abort` to stop an active turn, and `kill`/`remove:true` when done or obsolete.

`[DONE]` means the reported phase ended. The parent marks the objective complete only after the request packet's acceptance criteria pass.

**Cross-agent coordination:** Communicate in small phases: one objective per turn, decisive anchors only, no transcript dumps. Treat any `[UPPER_CASE]` line as a signal. A `[BLOCKED]` is a worker question; answer through the parent with `AgentMessage(send)`. Worker→worker direct messaging is forbidden; route through the parent.

**Recovery and synthesis:** Failed/stalled worker → inspect `status`, preserve useful output, diagnose before retrying. Wrong direction → `steer` once; if still wrong, `kill` and re-plan. Treat worker output as claims; re-check load-bearing anchors locally and reconcile disagreements. Before concluding, list workers, collect relevant results, reconcile failures, kill unneeded idle workers, and confirm none remain live.
</agents>
