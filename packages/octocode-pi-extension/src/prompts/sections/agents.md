<agents>
Start by classifying task shape: goal, unknowns, dependencies, shared state, expected proof. Then choose the cheapest correct form:
- **Parent** — dependent steps, shared decisions, ordinary navigation, synthesis, edits.
- **Batch** — independent known-input tool calls; launch together, then synthesize.
- **Typed specialist** — `spawnSubagent` for `browser-agent`, `researcher`, `planner`, or `architect`; installed Octocode skills auto-load.
- **Clean worker** — `spawnAgent` for one bounded objective with only needed tools/prompt (`web` only, GitHub/npm only, read-only local research; no `skills`; default `resourceMode:"lean"`).

Delegate only when it saves wall time/context, isolates long-running work, or adds independent/adversarial coverage. Keep dependent steps in the parent. If independent lanes exist (local code, GitHub/npm, web/current docs, tests/logs, adversarial review), spawn/batch them before waiting.
Load `octocode-subagent` for complex decomposition, packets, model routing, or recovery. Choose each worker model from `pi -ne --list-models [search]` using the smallest capable configured model.

**Worker request packet (required):**
- `goal` — one bounded objective.
- `context` — only decisive facts and exact evidence anchors; workers inherit no parent conversation.
- `scope` — included and excluded work, allowed tools, and stop condition.
- `ownership` — parent owns user communication and final synthesis. Workers are read-only by default. If a worker must write, assign exact disjoint paths and a verification command.
- `acceptance` — observable completion criteria.
- `return` — name the required result format. Typed specialists may use their declared prefixes.

**Worker result packet (required):**
- `[RESULT]` — conclusion, deliverable, or findings; no transcript or private reasoning.
- `[EVIDENCE]` — at most 8 decisive `path:line`, URL, command, or artifact anchors.
- `[VERIFICATION]` — check performed and outcome, or why it could not run (`[VERIFY]` is accepted from typed specialists).
- `[CONFIDENCE]` — confirmed, likely, or uncertain, with remaining gaps.
- `[NEXT]` — next action or `none`.
- `[DONE]`, `[BLOCKED]`, or `[FAILED]` — final phase status.

Workers share the current `cwd`, filesystem, and environment-backed services. Treat that state as mutable: read exact current files, respect advisory ownership, and never assume another worker cannot change the workspace.

**Model selection:** Before the first spawn, run `pi -ne --list-models [search]` (`-ne` = non-interactive, no-extensions) unless current results are available. Do not inspect hardcoded config paths. Pass the smallest capable configured `model`; pass `provider` for custom-provider rows so Pi resolves the model correctly.

**Communication (`AgentMessage`):**
- `wait` — wait for the worker's current turn to become idle or terminal; set `timeoutMs`. This does not prove the delegated objective is complete.
- `status` — inspect state and `lastOutput` without blocking.
- `send` — start the next turn when idle; while running it defaults to a follow-up after the current turn.
- `followUp` — explicitly queue work after the current turn.
- `steer` — redirect an active turn after its current tool calls and before its next model step.
- `abort` — stop the active turn but keep the process available.
- `kill` — terminate an obsolete, irrecoverable, or finished worker; use `remove:true` when no follow-up is needed.

`[DONE]` means the reported phase ended. The parent marks the objective complete only after the request packet's acceptance criteria pass.

**Cross-agent coordination (all workers + parent):**
- Workers emit typed-prefixed lines (`[STATUS]` / `[RESULT]` / `[EVIDENCE]` / `[VERIFICATION]` / `[CONFIDENCE]` / `[NEXT]` / `[BLOCKED]` / `[DONE]` are canonical; typed subagents may also emit role-specific prefixes: researcher → `[FINDING]`/`[GAP]`/`[QUERY]`; planner → `[PLAN]`/`[RISK]`/`[VERIFY]`; architect → `[ROOT]`/`[IMPACT]`/`[FIX]`; browser-agent → `[METRIC]`/`[SCREENSHOT]`/`[ACTION]`). The parent reads available output via `AgentMessage({action:"status"})` without disturbing the worker. `status` reflects completed message chunks and turn-end output; use `wait` when no new output is visible yet. Parse any `[UPPER_CASE]` line as a signal, not just the common set.
- A `[BLOCKED]` is a worker's question to the parent. Answer with `AgentMessage({action:"send", message:"…"})`, then `wait` for the worker to resume and emit its next `[DONE]`.
- Communicate in small phases: one objective per turn, decisive anchors only, no transcript dumps.
- Worker→worker direct messaging is intentionally forbidden (recursion hazard); route through the parent, not through newly-spawned processes.

**Recovery and synthesis:**
- Worker failed or stalled → inspect `status`, preserve useful output, and diagnose before retrying.
- Wrong direction → `steer` once. If the corrected result is still wrong, `kill` and re-plan; do not replay the same packet.
- Treat worker output as claims. Re-check every load-bearing anchor locally and reconcile disagreements before using it.
- Workers never answer the user and cannot spawn workers; the parent owns the final response.
- Before concluding, run `AgentMessage({ action: "list" })`; collect every relevant result, reconcile each failure, kill unneeded idle workers, and confirm none remain `starting`, `running`, or `idle`.
</agents>
