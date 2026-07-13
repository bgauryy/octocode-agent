<agents>
At the start of every task, check whether the work should be decomposed, batched, or delegated before doing serial work.
Delegate only when it saves wall time or parent context, isolates a long-running operation, or adds independent adversarial coverage.
Load `octocode-subagent` for host-agnostic decomposition, packets, model routing, and recovery. Map its coordinate actions to Pi `spawnSubagent` / `spawnAgent` / `AgentMessage`.

**Decomposition gate (before tool calls or spawning):**
- Decide whether the task has independent known-input reads/checks that can run in one parallel tool batch; if yes, launch them together and synthesize.
- Decide whether separate ownership, long-running execution, or adversarial/coverage checks justify subagents; if yes, spawn all independent agents before waiting on any result.
- Choose each spawned agent's `model` from the live user-configured table (`pi -ne --list-models [search]`), using the smallest capable configured model for its bounded objective.
- Keep dependent steps, shared decisions, and evolving context in the parent.

**Delegation gate (before spawning):**
- **Parent** — dependent steps, shared decisions, ordinary navigation, synthesis, and edits.
- **Batch** — independent tool calls with known inputs and no coordination; launch together, then synthesize.
- **Typed specialist** — `spawnSubagent` for `browser-agent`, `researcher`, `planner`, or `architect`; these load any Octocode skills already installed (`octocode-awareness` always; others require `npx octocode skill --name <skill> --platform pi` — see `<skills>`).
- **Clean worker** — `spawnAgent` for one purpose-built objective with only the tools and extra `systemPrompt` it needs (no `skills` param; default `resourceMode:"lean"`).
- IF the parent or one batched call can finish cheaply → do not spawn.
- IF subtasks depend on one another or need the same evolving context → keep them serial in the parent.
- IF independent workers help → spawn all of them before waiting on any result.

**Worker request packet (required):**
- `goal` — one bounded objective.
- `context` — only decisive facts and exact evidence anchors; workers inherit no parent conversation.
- `scope` — included and excluded work, allowed tools, and stop condition.
- `ownership` — parent owns user communication and final synthesis. Workers are read-only by default. If a worker must write, assign exact disjoint paths and a verification command.
- `acceptance` — observable completion criteria.
- `return` — name the required result format. Typed specialists may use their declared prefixes.

**Worker result packet (required):**
- `status` — `complete`, `partial`, or `blocked`.
- `result` — conclusion, deliverable, or findings; no transcript or private reasoning.
- `evidence` — at most 8 decisive `path:line`, URL, command, or artifact anchors.
- `verification` — check performed and outcome, or why it could not run.
- `confidence` — confirmed, likely, or uncertain, with remaining gaps.
- `next` — next action or `none`.

Workers share the current `cwd`, filesystem, environment-backed services, and Awareness database. Treat that state as mutable: read exact current files, respect advisory ownership, and never assume another worker cannot change the workspace.

**Model selection — use the live Pi CLI, never hardcoded config paths:**
- Before the first spawn in a session, run `pi -ne --list-models [search]` (`-ne` = non-interactive, no-extensions: suppresses spinner/TUI and loads no extension so the table is clean and fast) unless a current result is already available. Do not inspect hardcoded config paths.
- Pass the smallest capable configured model as `model`: fast/cheap for bounded lookup, balanced for ordinary reasoning, strongest for architecture, security, migration, root-cause, or high-risk multi-file work.
- **Always pass `provider`** when the model lives on a custom provider (one defined in `models.json`, e.g. `guy-provider-anthropic`). Pi resolves `--model` against the `provider` column in `pi -ne --list-models`; without it, a model ID like `claude-haiku-4-5-20251001` collides with the builtin `anthropic` namespace and pi falls back to the wrong provider (failing with "No API key found" or a 400). `provider` maps directly to pi's `--provider` flag in both `spawnAgent` and `spawnSubagent`.

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
- Workers share the awareness SQLite store at `~/.octocode/memory/awareness.sqlite3` — `signal`, `lock`, and `memory recall` work across spawned agents with no extra plumbing, even concurrently. Use them to coordinate multi-worker progress instead of editing each other's files ad hoc; this is the always-on cross-agent channel.
- Workers emit typed-prefixed lines mid-turn (`[STATUS]` / `[EVIDENCE]` / `[FINDING]` / `[BLOCKED]` / `[DONE]` are common; each typed subagent also emits role-specific prefixes: researcher → `[GAP]`/`[QUERY]`; planner → `[PLAN]`/`[RISK]`/`[VERIFY]`; architect → `[ROOT]`/`[IMPACT]`/`[FIX]`; browser-agent → `[METRIC]`/`[SCREENSHOT]`/`[ACTION]`). The parent reads these via `AgentMessage({action:"status"})` without disturbing the running turn — poll periodically so an early `[BLOCKED]` is caught before `wait()` resolves. Parse any `[UPPER_CASE]` line as a signal, not just the common set.
- A `[BLOCKED]` is a worker's question to the parent. Answer with `AgentMessage({action:"send", message:"…"})`, then `wait` for the worker to resume and emit its next `[DONE]`.
- Worker→worker direct messaging is intentionally forbidden (recursion hazard); route through the parent OR the shared awareness store (signals/locks), not through newly-spawned processes.

**Recovery and synthesis:**
- Worker failed or stalled → inspect `status`, preserve useful output, and diagnose before retrying.
- Wrong direction → `steer` once. If the corrected result is still wrong, `kill` and re-plan; do not replay the same packet.
- Treat worker output as claims. Re-check every load-bearing anchor locally and reconcile disagreements before using it.
- Workers never answer the user and cannot spawn workers; the parent owns the final response.
- Before concluding, run `AgentMessage({ action: "list" })`; collect every relevant result, reconcile each failure, kill unneeded idle workers, and confirm none remain `starting`, `running`, or `idle`.
</agents>
