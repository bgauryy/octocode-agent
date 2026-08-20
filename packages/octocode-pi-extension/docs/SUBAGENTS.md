# Subagents & Agent Communication

How the extension spawns agents, the types available, and the **communication + isolation**
model (parent↔worker control, grouped peers, parent-only isolation). Verified against the
awareness signal ACL and the `AgentMessage` surface.

## Two ways to spawn

| Tool | Use | Isolation default |
|---|---|---|
| `spawnSubagent` | **Typed** specialist (pre-wired tools + system prompt + Octocode skills) | `resourceMode:"octocode"` (has the awareness peer bus) |
| `spawnAgent` | **Clean** worker: only the tools/prompt you pass | `resourceMode:"lean"` (no skills/peer bus unless added) |

Workers never receive `spawnAgent`/`AgentMessage` — **no recursive spawning**. Both return an
`agentId` coordinated via `AgentMessage`.

## Typed subagents (all types)

| Type | Tools | Model | When to use |
|---|---|---|---|
| `researcher` | `web`, `MCPTool` | default | Fast evidence gathering: prior art, package/repo lookup, concise claim ledgers. |
| `architect` | `bash`, `web`, `MCPTool` | default | Root-cause + local-code architecture; targeted debug/test loops (has `bash`). |
| `planner` | `web`, `MCPTool` | default | Dependency-ordered plans, risks, verification strategy, RFC handoff packets. |
| `browser-agent` | `chromeDebug`, `web`, `MCPTool` | default | Multi-turn Chrome DevTools work: security/network/DOM/coverage/workers/emulation. Gated by `OCTOCODE_CHROME_DEBUG`. |

All typed subagents load the bundled Octocode skills and (in `octocode` mode) the awareness
runtime. Pass `model`/`provider`/`thinking` per task (fastest capable for small, strongest for
large/high-risk); look models up with `pi -ne --list-models`.

## Communication model — two planes

### Plane A — Parent ↔ Worker (`AgentMessage`, in-process, live)
`send` · `followUp` · `steer` · `abort` · `kill` · `wait` · `status` · `list`.
- **Control/interrupt (parent→worker):** `steer` (redirect before the next model step), `abort`
  (graceful turn interrupt, worker survives), `kill remove:true` (terminate).
- **Worker→parent:** pull only — `wait`/`status` + terminal `[DONE]`/`[BLOCKED]`/`[FAILED]`
  result markers. No mid-turn push.
- **Worker↔worker: forbidden.** Route all cross-worker coordination through the parent.
- **Lifecycle rule:** kill each worker the moment you collect its final receipt unless you will
  send another turn — idle ≠ terminated (a worker holds a live process until killed or session
  shutdown).

### Plane B — Peer ↔ Peer (awareness `signal`, durable/async)
`signal publish|list|reply|ack|resolve` with `--to-agent` (directed) or broadcast, `--thread-id`
(threaded), `--kind` (`claim|handoff|question|reply|blocker|request|decision|fyi`), `--subject`,
`--body`, `--file`. Durable in SQLite; delivered at the next `before_agent_start` briefing
(fingerprint-deduped). Kinds are a closed enum — invalid kinds are rejected.

## Isolation & grouping (verified)

### Parent-only subagent (fully isolated)
Spawn **lean, without the awareness peer bus** (`spawnAgent`, `resourceMode:"lean"`, no awareness
CLI/tools). Its only channel is `AgentMessage`↔parent — it cannot see or send peer signals. Use
for untrusted/bounded work that must not touch shared coordination state.

### Grouped agents (only communicate with each other)
A **group is a convention over existing primitives — no new schema**:
- **Directed messages** (`--to-agent`) and **private threads** are visible only to their
  participants. A non-participant's inbox **excludes** the message, and reading the thread by id
  returns **empty (no leak)** — the thread ACL is `broadcast OR participant`, and reading never
  grants participation.
- **Scope** (`--workspace`/`--artifact`/`--repo`/`--ref`) partitions namespaces: agents in one
  scope don't see another scope's signals. A stable `--artifact group:<id>` is a clean group key.
- **Broadcast** (no `--to-agent`, e.g. `handoff`) is the explicit *non-group* path — it reaches
  every peer in scope.

Recipe for a private group `{A,B}`:
```bash
# members address each other directed + share one thread; non-members are excluded by the ACL
<cli> signal publish --agent-id A --to-agent B --kind request --subject "<x>" --body "<y>" --workspace "$PWD" --compact
<cli> signal reply --agent-id B --signal-id <id> --body "<ack>" --compact   # stays in the thread
```

Verified isolation (POC): member inbox has the message; non-member inbox excludes it; non-member
thread-read returns count 0 (no leak); broadcast still reaches non-members; a different workspace
scope does not see the message.

## Efficiency notes (tokens + timeliness)
- Peer delivery is **deduped** (`delivery_state` fingerprint) and **threaded** → no spam; only
  changed briefings are injected.
- Peer signals are **pull-at-next-turn** (async), not real-time. For near-real-time peer
  interruption, the highest-leverage add is a **tool-boundary poll** that self-injects a
  `followUp` for new *directed, unread, high-priority* signals (mirrors the verify-gate
  injection) — turning "next turn" into "next tool call" with one bounded SQLite read.
- Prefer directed/threaded over broadcast to keep group traffic private and cheap.

## Quick reference
```
spawnSubagent({agent, task, url?, port?, model?, provider?, thinking?})
spawnAgent({task, tools?, resourceMode?, model?, provider?, systemPrompt?})   # lean = parent-only isolation
AgentMessage({action:"wait|status|send|steer|followUp|abort|kill", agentId, message?, remove?})
```
