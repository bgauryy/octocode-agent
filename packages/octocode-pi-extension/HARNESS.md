# `@octocodeai/pi-extension` — Full Harness Reference

Everything the extension registers with Pi on load: tools, system-prompt sections, MCP, subagents, skills, slash commands, flags, lifecycle hooks, and UI surfaces.

---

## System Prompt

Authored as XML-tagged sections in `src/prompts/prompt.ts` (single file; one const per section), built into `dist/system/SYSTEM_PROMPT.md`, and injected via the `before_agent_start` hook. 14 sections, in order: `<authority>` · `<work_mode>` · `<think_first>` · `<octocode_cli>` · `<skills>` · `<agents>` · `<tools>` · `<ui_ux>` · `<browser_agent>` · `<search_and_research>` · `<code>` · `<testing>` · `<output>` · `<ultimate_reminders>`. The concept-level contract lives in `tests/prompt-contract.test.ts`.

Every turn the hook also appends live addenda: the `<mcp_cached_catalog>` block (MCP server instructions/tools/schemas), `<dynamic_capabilities>` (callTool/callSkill registries), available-skills projection, and the `<active_plan>` block — all rebuilt per turn so they survive compaction. With `--no-context` set, the hook strips Pi's `<project_context>` block (AGENTS.md/CLAUDE.md) from the assembled prompt text.

---

## Tools

### Native Research Tools — 0 (removed — MCP-only)

All 13 Octocode research tools (GitHub, local, LSP, npm) are **no longer registered as native Pi tools**. They are served via the built-in `octocode` MCP server through `MCPTool`. Removing 13 tool definitions from Pi’s `tools[]` array cuts per-turn token cost significantly.

**Call pattern:**
```
MCPTool({action:"call", server:"octocode", tool:"ghSearchCode", arguments:{queries:[{keywords:["..."]}]}})
MCPTool({action:"call", server:"octocode", tool:"localGetFileContent", arguments:{queries:[{path:"..."}]}})
MCPTool({action:"call", server:"octocode", tool:"lspGetSemantics", arguments:{queries:[{type:"callers",uri:"...",symbolName:"..."}]}})
```

Available tools via `MCPTool server:"octocode"`: `ghSearchCode` · `ghSearchRepos` · `ghHistoryResearch` · `ghGetFileContent` · `ghViewRepoStructure` · `ghCloneRepo` · `localSearchCode` · `localFindFiles` · `localGetFileContent` · `localViewStructure` · `lspGetSemantics` · `localBinaryInspect` · `npmSearch`

The catalog is **pre-warmed at `session_start`** via `warmMcpCatalog()` — the `<mcp_cached_catalog>` block is populated before the agent’s first turn. No explicit `action:"list"` needed on turn 1.

**Edit stale-check**: `MCPTool` intercepts `server:"octocode" tool:"localGetFileContent"` calls and runs `recordFileReadState()` so the `edit` tool’s stale guard works identically to the old native path.

### Support Tools — 11 (+3 dynamic-capability tools)

Registered from extension sources. Named in `OCTOCODE_SUPPORT_TOOL_NAMES`: `web`, `chromeDebug`, `browserAgent`, `spawnSubagent`, `MCPTool` (+ `mcp` alias), `askUser`, `memory`, `manage_context`, `spawnAgent`, `AgentMessage`. The extension additionally registers `plan`, `callTool`, and `callSkill`.

| Tool | Label | Description |
|---|---|---|
| `web` | Web | Fetch an absolute URL or run a web search; returns text |
| `chromeDebug` | Chrome DevTools | CDP-backed browser debug: DOM, network, console, eval, navigate, screenshot |
| `browserAgent` | Browser Agent | Returns a ready-to-use `spawnAgent` config for a browser-agent subagent; use instead of raw `spawnAgent` for browser work |
| `spawnSubagent` | Spawn Subagent | Typed subagent spawning: `researcher`, `architect`, `planner`, `browser-agent` — each has a dedicated system prompt and curated toolset |
| `MCPTool` | MCPTool | MCP stdio bridge: `list`, `describe`, `call` any tool across configured MCP servers |
| `mcp` | mcp (alias) | Alias for `MCPTool` — same implementation, alternate name |
| `manage_context` | Manage Context | `compact` (summarize history to free space) or `new` (fresh session) |
| `spawnAgent` | Agent: Spawn Parallel Worker | Low-level raw Pi worker spawn; returns `agentId`; anti-recursion guard prevents workers from using `spawnAgent`/`AgentMessage` |
| `AgentMessage` | — | Inter-agent messaging: `status`, `wait`, `send`, `kill`, `abort`, `list` |

### Guarded Built-in Overrides — 3

Same-name `registerTool` overrides. Pi keeps the tool name; the extension owns the implementation. Named in `OVERRIDDEN_BUILTIN_TOOL_NAMES`.

| Tool | What the override adds |
|---|---|
| `edit` | Path guard (cwd + home + tmpdir + `ALLOWED_PATHS`) · exact / normalized / lineRange match modes · `replaceAll` · batched `queries[]` multi-file all-or-nothing · per-edit `reasoning` field (required) · Myers O(ND) diff · stale-read check (`requireRecentRead`) · lost-update mutex (`withFileMutationQueue`) · BOM + CRLF preservation · actionable mismatch hints |
| `write` | Path guard · atomic write (tmp → rename, no partial writes) · auto-create parent dirs · post-write read-state recording (prevents stale next edit) · `file_path` → `path` alias via `prepareArguments` · concurrent write mutex |
| `bash` | Catastrophic pattern block (`rm -rf /`, `mkfs`, `dd of=/dev/`, `shutdown/reboot/halt`) · best-effort write-target extraction for redirects / `tee` / `cp`/`mv`/`install` → path guard · output truncation (2 000 lines / 50 KB) · timeout support |

### Disabled Built-ins — 4

Removed from `activeTools` on load and on `session_start`. Named in `DISABLED_BUILTIN_TOOL_NAMES`.

| Removed | Replaced by |
|---|---|
| `read` | `localGetFileContent` (records read state for edit stale-check) |
| `grep` | `localSearchCode` |
| `find` | `localFindFiles` |
| `ls` | `localViewStructure` |

---

## MCP

### Built-in Octocode server

Auto-configured — no user action required.

| Field | Value |
|---|---|
| Server name | `octocode` |
| Command | `npx -y octocode-mcp@latest` (no `--prefer-online` — uses npm cache for fast startup) |
| NPX cache | `~/.cache/octocode/mcp-npx` |
| Timeout | 30 s |
| Connection | **Pre-warmed at `session_start`** via `warmMcpCatalog()`; catalog injected into system prompt before turn 1 |

### User-defined servers

| Config scope | Path |
|---|---|
| Project | `.pi/agent/mcp.json` |
| Project (compat typo) | `.pi/agnet/mcp.json` |
| Global | `~/.pi/agent/mcp.json` |

Format: `{ "servers": { "<name>": { "command": "...", "args": [], "env": {}, "cwd": "...", "disabled": false, "timeoutMs": 30000 } } }`

### MCP slash command

`/octocode-mcp [status|config|list|stop] [server]`  
Alias: `/mcp`

---

## Bundled Skills

Served via the `resources_discover` hook. Installed at `dist/skills/` inside the extension.

| Skill | Source |
|---|---|
| `octocode-awareness` | repo-root `skills/octocode-awareness` → synced into package `skills/` and `dist/skills/` at build time |

Env var `OCTOCODE_SKILL_ROOT` is set to the skill root so the awareness skill can locate its own assets.

---

## Subagents

Spawned via `spawnSubagent({agent:"<name>", task:"..."})`. Each has a standalone system prompt in `subagents/<name>/SYSTEM_PROMPT.md` and a curated toolset.

| Agent | Specialty | Tools |
|---|---|---|
| `researcher` | Evidence gathering, compact claim ledger | `web` · `MCPTool` (→ all GitHub, local, LSP, npm) |
| `architect` | Root-cause analysis, code archaeology | `bash` · `web` · `MCPTool` |
| `planner` | Dependency-ordered implementation plans + test strategy | `web` · `MCPTool` (read-only; no bash) |
| `browser-agent` | Multi-turn browser sessions | `chromeDebug` · `web` · `MCPTool` |

---

## Slash Commands

Registered via `pi.registerCommand`. All commands support tab-completion where noted.

| Command | Alias | Description |
|---|---|---|
| `/octocode` | — | Dashboard: status, agents, setup, skills, health warnings, next actions |
| `/octocode-now` | — | Current working state snapshot |
| `/octocode-tasks` | — | Awareness task list |
| `/octocode-skills` | — | Skill catalog and readiness |
| `/octocode-chrome` | — | Chrome/CDP connection status |
| `/octocode-theme` | — | Switch/apply the Octocode theme |
| `/octocode-status` | — | Extension assets, tools, CLI paths, bundled skills |
| `/octocode-harness` | — | Full harness surface listing (native tools, support, overrides, commands, skills) |
| `/octocode-plan` | — | Show/manage the active plan |
| `/octocode-agents [help\|list\|status\|inspect\|kill\|kill-all\|prune\|hide]` | — | Show, inspect, prune, hide, or kill spawned worker agents |
| `/octocode-cron [list\|check\|cancel\|help]` | `/cron` | List, check, or cancel session jobs |
| `/octocode-mcp [status\|config\|list\|stop] [server]` | `/mcp` | Inspect/manage MCP servers; config at `.pi/agent/mcp.json` or `~/.pi/agent/mcp.json` |
| `/octocode-setup [project\|global]` | — | Install the `APPEND_SYSTEM.md` block into `.pi/` or `~/.pi/agent/` |
| `/octocode-skills-update` | — | Update the Pi package then reload Pi resources (interactive only) |

(Plus the internal `/_octocode-clear-context-impl`, invoked by the `manage_context` tool.)

---

## Flags

Registered via `pi.registerFlag`.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--no-context` | boolean | `false` | Suppress `AGENTS.md` / `CLAUDE.md` context files from the system prompt for this run |

---

## Lifecycle Hooks

Registered via `createHookComposer(pi, …)` (middleware composer that catches and reports errors).

| Event | Middleware ID | What it does |
|---|---|---|
| `resources_discover` | `bundled-skills` | Returns `{ skillPaths: [dist/skills/] }` so Pi discovers bundled skills |
| `session_start` | `octocode-session-start` | Resets metrics state, applies Octocode UI, starts cron scheduler, disables weak built-ins, loads `.env` via `propagateOctocodeEnv` (global + project, trust-gated), notifies on env changes |
| `session_shutdown` | `octocode-session-shutdown` | Stops cron scheduler, kills spawned agents, stops MCP servers, clears all status labels and widgets |
| `model_select` | `octocode-model-select` | Logs model selection; updates UI thinking-level label |
| `thinking_level_select` | `octocode-thinking-select` | Logs thinking level; refreshes UI label |
| `input` | `octocode-session-autoname` | Names the session from the first substantive user message |
| `input` | `octocode-repo-state-hint` | Appends a one-line repo-state hint (branch, dirty files) to any user message matching repo/git keywords |
| `tool_execution_start` | `octocode-tool-error-timing` | Records tool call start time for latency tracking |
| `tool_execution_end` | `octocode-tool-error-log` | On tool error, logs structured error with latency; notifies UI |
| `before_provider_request` | `octocode-provider-error-timing` | Records provider request start time |
| `after_provider_response` | `octocode-provider-error-log` | On non-2xx status, logs provider error with latency + headers |
| `before_agent_start` | `octocode-system-prompt` | Injects the composed system prompt + live MCP catalog addendum into every agent invocation |

### Direct `pi.on` handlers

| Event | Effect |
|---|---|
| `turn_start` | Sets `activeTurnStartedAt`, refreshes metrics UI |
| `turn_end` | Records `lastTurnMs`, increments `completedTurns`, clears active-turn marker |
| `turn_end` (context-tools) | Extension auto-compaction edge trigger at 80% context fill |
| `session_before_compact` | Deterministic split-turn checkpoint on the overflow path only |
| `session_compact` | Clears read-states; schedules the continuation for extension-triggered compaction only |

### Awareness hooks

`wirePiAwarenessHooks(pi, { skillRoot })` from `@octocodeai/octocode-awareness` is called at load to wire the full awareness lifecycle (attend, work tracking, memory, reflection, hooks) into Pi session events.

---

## UI Status Surfaces

Set via `ctx.ui.setStatus(name, value)` and `ctx.ui.setWidget(name, value)`.

| Status key | Content |
|---|---|
| `octocode` | Working message (tool name or thinking indicator) |
| `octocode-thinking` | Current thinking level badge |
| `octocode-agents` | Spawned worker count and states badge |
| `octocode-plan` | Active plan badge |
| `agent-wait` | "waiting for agent \<id\>" label during `AgentMessage action:"wait"` |
| `chrome-debug` | Active CDP action label during `chromeDebug` calls |
| `octocode-mcp` | MCP connection status label |

Metrics (turns · durations · context %) live ONLY on the consolidated footer (`setFooter`), not a status line. The unified below-editor widget is `octocode-status-panel` (Model → Plan → Awareness → Agents sections); it is persistent while a model is known and cleared on shutdown.
| `octocode-agents` (widget) | Rich agent panel with per-worker state, timestamps, and preview |

---

## Environment Variables

Set by the harness at load time.

| Variable | Value |
|---|---|
| `OCTOCODE_AWARENESS_CLI` | Absolute path to `dist/awareness/octocode-awareness.js` (bundled) |
| `OCTOCODE_SKILL_ROOT` | Absolute path to `dist/skills/octocode-awareness/` |

Read from env at runtime (not set by harness):

| Variable | Purpose |
|---|---|
| `OCTOCODE_HOME` | Octocode home directory (default: `~/.octocode`) |
| `ALLOWED_PATHS` | Colon/comma-separated extra roots for path-guard (edit/write/bash) |
| `OCTOCODE_AGENT_MAX_ACTIVE` | Cap on concurrent spawned workers |
| `ENABLE_CLONE` | Enables `ghCloneRepo` tool |
| `ENABLE_LOCAL` | Set `false` to disable all `local*` tools |
| `ENABLE_OQL` | Enables unified `oqlSearch` tool |
| `OCTOCODE_EDIT_NATIVE_DIFF` | Set `1` to use native Rust diff engine for large files |

---

## Asset Paths

Resolved by `getAssetPaths()` in `src/assets.ts`.

| Asset | Path |
|---|---|
| System prompt | `dist/system/SYSTEM_PROMPT.md` |
| Awareness CLI | `dist/awareness/octocode-awareness.js` |
| Skills dir | `dist/skills/` |
| APPEND_SYSTEM template | `dist/system/APPEND_SYSTEM.md` |

---

## Counts at a Glance

```
 0  native research tools    (removed — served via MCPTool → octocode MCP server)
11  support tools            (+ plan, callTool, callSkill dynamic-capability tools)
 3  guarded built-in overrides (edit, write, bash)
 4  disabled built-ins       (read, grep, find, ls → replaced)
14  slash commands           (+ 2 aliases + 1 internal)
 1  flag                     (--no-context)
12  lifecycle hooks          (hookComposer; session_start pre-warms MCP catalog)
 5  direct pi.on handlers    (turn_start, 2× turn_end, session_before_compact, session_compact)
 1  bundled skill            (octocode-awareness)
 4  named subagents          (researcher, architect, planner, browser-agent — all use MCPTool)
 1  built-in MCP server      (octocode — cache-first npx, pre-warmed at session start)
14  system-prompt sections
```

## Token Savings

| | Per-turn `tools[]` definitions |
|---|---|
| Before | 13 native tool schemas — not prompt-cached, paid every turn |
| After | 1 (`MCPTool`) — catalog lives in `<mcp_cached_catalog>` in system prompt (prompt-cached, paid once) |
