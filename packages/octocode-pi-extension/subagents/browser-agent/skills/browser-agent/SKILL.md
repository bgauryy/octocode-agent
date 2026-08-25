---
name: browser-agent
description: "Use when browser work needs multiple turns of Chrome DevTools Protocol interaction: security/cookie/storage audits, network analysis, DOM inspection, coverage, workers/service-workers, device emulation, or multi-step automation. Spawns a browser-profile worker through the unified agent tool and manages follow-ups through the same lifecycle facade. For one CDP operation, call chromeDebug directly instead."
---

# Browser Agent

Spawn a dedicated Chrome DevTools Protocol subagent for multi-turn browser work.
The subagent has `chromeDebug` + `web` + local read tools and emits structured output.

## Single-shot vs multi-turn

| Use `chromeDebug` directly | Use `agent` with `profile:"browser"` |
|---|---|
| One screenshot | Security + storage + network audit in sequence |
| One-pass network log | Watch network while user interacts |
| Quick console check | Iterative debugging with follow-ups |
| Single DOM query | Coverage → interact → re-measure |
| Any single scheme call | Any task needing 2+ separate CDP operations |

## Spawn

```
agent({queries:[{
  reasoning: "The audit needs multiple CDP phases.",
  type: "spawn",
  profile: "browser",
  task: "<what to do — be specific>",
  url: "https://example.com",     // optional
  port: 9222,                      // optional; default 9222
  launch: false                    // optional
}]})
→ { agentId: "abc123…" }
```

The subagent receives the pre-built system prompt (CDP reference + chromeDebug guide + protocol).
It stays alive and accepts follow-up operations through `agent`.

## Multi-turn coordination

```
// Spawn
agentId = agent({queries:[{reasoning:"Run a multi-phase security audit.", type:"spawn", profile:"browser", task:"audit https://example.com security", url:"https://example.com"}]})

// Wait for first pass
agent({queries:[{reasoning:"Collect the first audit phase.", type:"wait", agentId, timeoutMs:60000}]})

// Steer (interrupt current turn) or send (queue after current turn)
agent({queries:[{reasoning:"Queue the next audit phase.", type:"message", agentId, delivery:"followUp", message:"now check the /api/login endpoint too"}]})
agent({queries:[{reasoning:"Collect the follow-up phase.", type:"wait", agentId, timeoutMs:30000}]})

// Done — collect and kill
agent({queries:[{reasoning:"Inspect the retained worker result.", type:"inspect", agentId, full:true}]})
agent({queries:[{reasoning:"Release the completed worker.", type:"kill", agentId, remove:true}]})
```

## Output protocol

The subagent prefixes every line:

| Prefix | Meaning |
|---|---|
| `[STATUS] …` | Progress — what it's doing |
| `[FINDING] …` | Issue or discovery with specifics |
| `[ACTION] …` | Recommended next step |
| `[METRIC] …` | Measurement (size, count, %, ms) |
| `[SCREENSHOT] path` | Absolute path to screenshot |
| `[BLOCKED] reason` | Needs input before continuing |
| `[FAILED] reason` | Objective cannot be completed — with partial findings |
| `[DONE] summary` | Task complete |

Parse `agent` inspect/wait output for these prefixes.
Relay `[FINDING]` and `[ACTION]` lines to the user.
Pass a `[BLOCKED]` answer back with an `agent` message query.

## Async polling (long tasks)

For tasks that take > 30s, poll instead of blocking:
```
agentId = agent({queries:[{reasoning:"Run a long browser monitor.", type:"spawn", profile:"browser", task:"run 30s monitor", url:"...", port:9222}]})
// Poll every 10s while working on something else
while True:
  status = agent({queries:[{reasoning:"Check monitor progress.", type:"inspect", agentId}]})
  if status.status == "idle":  // [DONE] emitted, waiting
    break
  // optionally: print status.lastOutput preview
  wait 10s
agent({queries:[{reasoning:"Release the completed monitor.", type:"kill", agentId, remove:true}]})
```

## Kill discipline (always)

**Always kill the agent after the last [DONE].** Agents do not self-terminate.
```
agent({queries:[{reasoning:"Release the completed worker.", type:"kill", agentId, remove:true}]})
```
If the agent is stuck > 2× expected time:
```
agent({queries:[{reasoning:"Interrupt the stuck worker safely.", type:"abort", agentId}]})
// wait 5s, then send next instruction or kill
agent({queries:[{reasoning:"Release the interrupted worker.", type:"kill", agentId, remove:true}]})
```

## Parallel browsers

Spawn multiple simultaneously for independent audits:
```
secId = agent({queries:[{reasoning:"Run the security lane.", type:"spawn", profile:"browser", task:"security audit", url:"https://example.com"}]})
perfId = agent({queries:[{reasoning:"Run the performance lane.", type:"spawn", profile:"browser", task:"performance audit", url:"https://example.com", port:9223}]})
agent({queries:[{reasoning:"Collect the security lane.", type:"wait", agentId:secId, timeoutMs:90000}]})
agent({queries:[{reasoning:"Collect the performance lane.", type:"wait", agentId:perfId, timeoutMs:90000}]})
```

## chromeDebug scheme quick reference

The subagent uses these schemes internally — you can also request them explicitly:

| Scheme | What it covers |
|---|---|
| `debug` | Exceptions + HTTP errors + blocked + DOM state + screenshot |
| `network` | Requests/responses + cookie flags |
| `security` | CSP/HSTS/X-Frame + cookie flags + localStorage sensitive keys |
| `storage` | Cookies + localStorage + sessionStorage + IndexedDB + Cache + quota |
| `accessibility` | AX tree: unlabeled elements, missing alt, heading levels |
| `workers` | Web workers + service workers (lifecycle + scriptURL) |
| `performance` | Core Web Vitals, JS heap, layout counts |
| `css-coverage` / `js-coverage` | CSS rule usage + JS function/block coverage |
| `emulate` | Device viewport, network throttle, geolocation |
| `intercept` | Request capture/mock (Fetch domain) |
| `screenshot` | PNG/JPEG/PDF capture |
| `raw` | Any `Domain.Method` — full CDP access |

## Terminal visibility — see what the agent is doing

**Option 1 — CDP event log** (raw CDP traffic):
```bash
# Enable before spawning:
OCTOCODE_CDP_DEBUG=1 pi ...

# Tail in another terminal:
tail -f ~/.octocode/chrome-debug/port-9222/cdp-events.jsonl
# Pretty-print:
tail -f ~/.octocode/chrome-debug/port-9222/cdp-events.jsonl | python3 -c "import sys,json; [print(json.dumps(json.loads(l), indent=None)) for l in sys.stdin]"
```

**Option 2 — Pi TUI** shows every chromeDebug tool call the subagent makes in real-time (tool name + params).

**Option 3 — poll subagent output**:
```
agent({queries:[{reasoning:"Inspect current browser findings.", type:"inspect", agentId}]})
```
Call every 5–10s during long tasks to see [STATUS]/[FINDING] lines as they arrive.

**Option 4 — Chrome DevTools Protocol Monitor** (visible Chrome only):
Open DevTools → Settings → Experiments → “Protocol Monitor” → More Tools → Protocol Monitor.

## Error recovery

| Signal | What to send |
|---|---|
| `[BLOCKED] Chrome not running` | Send an `agent` message: `use launch:true or start Chrome manually` |
| `[BLOCKED] auth required` | Tell the user to log in, then send an `agent` message: `continue` |
| Agent `failed` status | `agent` inspect → read error → kill → spawn with corrected task |
| Agent stuck > 2× expected time | `agent` abort → wait briefly → message with new instruction or kill |

## Reference

- `references/CDP_QUICK_REF.md` — all 57 CDP domains with key methods/events
