# Subagents & Agent Communication

How the extension spawns agents, the types available, and the **communication + isolation**
model (parent↔worker control, durable Awareness Lite notes, parent-only isolation). Verified
against the Awareness Lite message surface and `AgentMessage` controls.

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
- **Worker↔worker live control: parent-only.** Workers do not receive `AgentMessage` or
  spawn tools, so they cannot steer/interrupt/kill each other. They may communicate through
  durable Awareness Lite `message`/`handoff` notes when the worker has the Lite CLI available.
- **Lifecycle rule:** kill each worker the moment you collect its final receipt unless you will
  send another turn — idle ≠ terminated (a worker holds a live process until killed or session
  shutdown).

### Plane B — Peer ↔ Peer (Awareness Lite `message`, durable/async)
`message send|inbox|list|read|prune` supports directed `--to` messages or
broadcast coordination notes with `--topic`, `--text`, and optional `--file`. Durable in SQLite;
agents pull the inbox explicitly through `npx @octocodeai/octocode-awareness-lite` rather than receiving
real-time worker-to-worker pushes.

## Isolation & grouping (verified)

### Parent-only subagent (fully isolated)
Spawn **lean, without the Awareness Lite peer bus** (`spawnAgent`, `resourceMode:"lean"`, no
Awareness Lite CLI/tool path unless explicitly provided). Its only live channel is
`AgentMessage`↔parent. Use for untrusted/bounded work that must not touch shared coordination
state.

### Grouped agents (only communicate with each other)
A **group is a convention over existing primitives — no new schema**:
- **Directed messages** (`--to`) are addressed to one peer; broadcasts omit a target.
- **Scope** is primarily `--workspace`; agents in one workspace do not see another workspace's
  messages, handoffs, tasks, locks, or work presence.
- **Handoffs** are explicit continuation notes for later agents, not live group chat.

Recipe for a private group `{A,B}`:
```bash
# member A leaves a directed async note for B
npx @octocodeai/octocode-awareness-lite message send --workspace "$PWD" --from A --to B --topic "<x>" --text "<y>"
npx @octocodeai/octocode-awareness-lite message inbox --workspace "$PWD" --agent-id B
```

Expected isolation: the addressed peer can see the message in its inbox; broadcast messages are
visible to peers in the same workspace; a different workspace scope does not see the message.

## Efficiency notes (tokens + timeliness)
- Peer messages are **pull-based** and async, not real-time.
- For urgent coordination, the parent should poll `message inbox`/worker status and steer workers.
- Prefer directed messages over broadcast to keep coordination private and cheap.

## Quick reference
```
spawnSubagent({agent, task, url?, port?, model?, provider?, thinking?})
spawnAgent({task, tools?, resourceMode?, model?, provider?, systemPrompt?})   # lean = parent-only isolation
AgentMessage({action:"wait|status|send|steer|followUp|abort|kill", agentId, message?, remove?})
```
