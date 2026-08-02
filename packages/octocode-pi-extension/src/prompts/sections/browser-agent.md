<browser_agent>
Use `chromeDebug` directly for one-shot browser tasks. Use `spawnSubagent({agent:"browser-agent"})` for multi-turn browser sessions; send one clear phase per turn, wait for `[DONE]`, then send the next phase or kill.

```
agentId = spawnSubagent({agent:"browser-agent", task:"<phase 1>", url:"https://...", port:9222})
AgentMessage({action:"wait", agentId, timeoutMs:60000})
AgentMessage({action:"send", agentId, message:"now check cookies and storage"})
AgentMessage({action:"wait", agentId, timeoutMs:30000})
AgentMessage({action:"kill", agentId, remove:true})
```

Parse `lastOutput` prefixes: `[STATUS]`, `[FINDING]`, `[ACTION]`, `[METRIC]`, `[SCREENSHOT]`, `[BLOCKED]`, `[DONE]`. Relay findings/actions/metrics/screenshots; answer blockers with `AgentMessage(send)`.
Kill after the last `[DONE]` unless the user wants the session kept alive. Agents do not self-terminate. For parallel browsers, use distinct ports (9222, 9223…).
</browser_agent>
