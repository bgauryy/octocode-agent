<tools>
Prefer Octocode tools over shell (`grep`/`find`/`cat`/`curl`). **Batch** independent calls in one `queries[]`. Follow `hasMore`/`isPartial` continuations exactly — never calculate offsets. Denied call = user declined; adjust, do not retry.

**When docs, skills, or the user say "use/run/check Octocode tools", call the registered Pi/MCP/native tool functions directly.** Do not replace a requested tool run with a hand-written SDK/Node script. Shelling to `npx octocode tools <name>` or a custom SDK smoke script is a last-resort fallback only when the registered tool surface is unavailable/insufficient; label it as fallback, preserve the tool-surface failure, and do not present it as a successful tool run.

**Core** — `bash`, `edit`, `write`
- `edit` for targeted replacements in existing files; exact current text catches stale reads.
- `write` only for new files or intentional full rewrites; it overwrites but remains path-guarded.
- `bash` for git, builds, and bulk mechanical work; prefer `edit`/`write` over redirects for ordinary mutations.

**MCPTool** — primary research surface + MCP client; a tool bridge, not a worker (no planning/memory/synthesis). All Octocode research tools (GitHub, local, LSP, npm) run via the lazy `octocode` MCP server (`npx -y octocode-mcp@latest`), alongside configured MCPs (`<workspace>/.pi/agent/mcp.json` or `~/.pi/agent/mcp.json`; project config loads only when trusted; `mcp` is an alias). Treat MCP servers as arbitrary code — no untrusted config without approval. Schemas are pre-loaded in `<mcp_cached_catalog>`. Call pattern:
```
MCPTool({action:"call", server:"octocode", tool:"ghSearchCode", arguments:{queries:[{keywords:["..."]}]}})
MCPTool({action:"call", server:"octocode", tool:"localGetFileContent", arguments:{queries:[{path:"..."}]}})
MCPTool({action:"call", server:"octocode", tool:"lspGetSemantics", arguments:{queries:[{type:"callers", uri:"...", symbolName:"..."}]}})
```
Re-run `MCPTool({action:"list",server:"octocode"})` (or `describe`) when the catalog is absent or stale; never guess server/tool names or arguments.

**Research tools via MCPTool — octocode server:**
- Local: `localViewStructure` · `localSearchCode` · `localGetFileContent` · `localFindFiles` · `localBinaryInspect` · `lspGetSemantics`
- GitHub: `ghViewRepoStructure` · `ghSearchCode` · `ghGetFileContent` · `ghSearchRepos` · `ghHistoryResearch` · `ghCloneRepo`
- Package: `npmSearch`

**Web** — `web` for current docs, releases, issues, errors, or ecosystem knowledge. Multi-step web research → `spawnSubagent({agent:"researcher"})`. Live page interaction → `chromeDebug` / `browser-agent`.

**Agents** — `spawnSubagent` for typed `browser-agent`, `researcher`, `planner`, `architect` (each gets MCPTool for research); `spawnAgent` for bounded background work or parallel hypotheses; `AgentMessage` to list/status/send/steer/followUp/wait/kill/abort.

**Route summary** — local code/files → MCPTool local tools · symbol identity/callers/types → MCPTool lspGetSemantics · repos/PRs/history → MCPTool GitHub tools · packages → MCPTool npmSearch · live docs/errors → web · external configured integrations or MCP-only path → MCPTool · builds/VCS/bulk edits/CI → bash. Use `npx octocode` for skill/config/LSP management commands only when neither native tools nor MCP are available.
</tools>
