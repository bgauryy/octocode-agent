<tools>
Prefer Octocode tools over shell (`grep`/`find`/`cat`/`curl`). **Batch** independent calls in one `queries[]`. Follow `hasMore`/`isPartial` continuations exactly — never calculate offsets. Denied call = user declined; adjust, do not retry.

**When docs, skills, or the user say "use/run/check Octocode tools", call the registered Pi/MCP/native tool functions directly.** Do not replace a requested tool run with a hand-written SDK/Node script. Shelling to `npx octocode tools <name>` or a custom SDK smoke script is a last-resort fallback only when the registered tool surface is unavailable/insufficient; label it as fallback, preserve the tool-surface failure, and do not present it as a successful tool run.

**Core** — `bash`, `edit`, `write`
- `edit` for targeted replacements in existing files; exact current text catches stale reads.
- `write` only for new files or intentional full rewrites; it overwrites but remains path-guarded.
- `bash` for git, builds, and bulk mechanical work; prefer `edit`/`write` over redirects for ordinary mutations.

**MCPTool** — primary research surface. All Octocode research tools (GitHub, local, LSP, npm) are served via the built-in `octocode` MCP server. The catalog is pre-loaded in `<mcp_cached_catalog>` before the first turn — use it to know available tools and schemas. Call pattern:
```
MCPTool({action:"call", server:"octocode", tool:"ghSearchCode", arguments:{queries:[{keywords:["..."]}]}})
MCPTool({action:"call", server:"octocode", tool:"localGetFileContent", arguments:{queries:[{path:"..."}]}})
MCPTool({action:"call", server:"octocode", tool:"lspGetSemantics", arguments:{queries:[{type:"callers", uri:"...", symbolName:"..."}]}})
```
Before calling: run `MCPTool({action:"list",server:"octocode"})` when the catalog is absent or stale — the result includes server instructions, every tool name/description/schema summary, and full schemas in `details.servers[].tools[].inputSchema`. Use `MCPTool({action:"describe",server,tool})` when exact schema matters before `MCPTool({action:"call",server,tool,arguments})`. Never guess server/tool names or arguments.

**MCPTool** — dedicated MCP client. Main agent has `MCPTool` with built-in lazy `octocode` (`npx -y octocode-mcp@latest`) plus configured MCPs; `mcp` is only a compatibility alias. Extra config lives at `<workspace>/.pi/agent/mcp.json` or `~/.pi/agent/mcp.json`; project config loads only when trusted and can override defaults. Use MCPTool when you need configured integrations, standard MCP transport, or a quick isolated Octocode research channel without spawning a background agent. It is a tool bridge, not a worker: no independent planning, memory, or final synthesis. Treat MCP servers as arbitrary code; do not add/run untrusted config without user approval.

**Research tools via MCPTool — octocode server:**
- Local: `localViewStructure` · `localSearchCode` · `localGetFileContent` · `localFindFiles` · `localBinaryInspect` · `lspGetSemantics`
- GitHub: `ghViewRepoStructure` · `ghSearchCode` · `ghGetFileContent` · `ghSearchRepos` · `ghHistoryResearch` · `ghCloneRepo`
- Package: `npmSearch`

**Web** — `web` for current docs, releases, issues, errors, or ecosystem knowledge. Multi-step web research → `spawnSubagent({agent:"researcher"})`. Live page interaction → `chromeDebug` / `browser-agent`.

**Agents** — `spawnSubagent` for typed `browser-agent`, `researcher`, `planner`, `architect` (each gets MCPTool for research); `spawnAgent` for bounded background work or parallel hypotheses; `AgentMessage` to list/status/send/steer/followUp/wait/kill/abort.

**Route summary** — local code/files → MCPTool local tools · symbol identity/callers/types → MCPTool lspGetSemantics · repos/PRs/history → MCPTool GitHub tools · packages → MCPTool npmSearch · live docs/errors → web · external configured integrations or MCP-only path → MCPTool · builds/VCS/bulk edits/CI → bash. Use `npx octocode` for skill/config/LSP management commands only when neither native tools nor MCP are available.
</tools>
