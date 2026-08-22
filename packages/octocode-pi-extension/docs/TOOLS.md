# Tools Reference — Pi Extension

Complete reference for every tool registered by `@octocodeai/pi-extension`. The 13 Octocode research tools delegate execution to `@octocodeai/octocode-tools-core`; the Pi-specific tools are implemented directly in `src/tools/`.

Pi’s default `read`/`grep`/`find`/`ls` are removed and `edit`/`write`/`bash` are
replaced by Octocode implementations. See **[OVERRIDES.md](./OVERRIDES.md)** for
why, the user-facing rules, and the developer code map.

---

## Tool Inventory

| Family | Tools |
|--------|-------|
| **Core** | `bash`, `edit`, `write` |
| **GitHub** | `ghSearchCode` · `ghSearchRepos` · `ghHistoryResearch` · `ghGetFileContent` · `ghViewRepoStructure` · `ghCloneRepo` |
| **Local** | `localSearchCode` · `localViewStructure` · `localFindFiles` · `localGetFileContent` · `localBinaryInspect` |
| **LSP** | `lspGetSemantics` |
| **Package** | `npmSearch` |
| **Browser** | `chromeDebug` · `browserAgent` · `spawnSubagent` |
| **Agents** | `spawnAgent` · `AgentMessage` |
| **Media** | `readImage` · `createImage` |
| **Web** | `web` |
| **MCP** | `MCPTool` (`/mcp` is a slash-command alias, not a tool alias) |
| **Meta** | `callTool` — self-extending dynamic-tool factory (CRUD modes: `list` · `create` · `run` · `enhance`/`fix` update · `delete` · auto-maintain) |
| **Meta** | `callSkill` — self-extending dynamic-**skill** factory for reusable multi-step workflows (modes: `list` · `create` · `use` · `enhance`/`fix` · `delete` · auto-maintain) |
| **Context** | `manage_context` |
| **Memory** | `memory` — lightweight wrapper over Awareness Lite memory recall/record/forget |
| **Coordination** | *No tools.* Use `npx @octocodeai/octocode-awareness-lite <noun> <verb>` for status/plan/task/work/lock/handoff/check/message (see Memory / Awareness below) |

Session-scoped maintenance jobs are controlled by `/octocode-cron`; see [CRON.md](./CRON.md).
Source of truth for names: `OCTOCODE_DIRECT_TOOL_NAMES` + `OCTOCODE_SUPPORT_TOOL_NAMES` in `src/constants.ts`.

---

## Routing Guide

| Task | Tool |
|------|------|
| Run shell commands, git, builds | `bash` |
| Edit existing file (exact replacement) | `edit` |
| Create / overwrite a file | `write` |
| Search code across GitHub | `ghSearchCode` |
| Read a file from GitHub | `ghGetFileContent` |
| Browse a GitHub repo tree | `ghViewRepoStructure` |
| Discover GitHub repos | `ghSearchRepos` |
| Search PR / commit history | `ghHistoryResearch` |
| Clone repo for local reads | `ghCloneRepo` |
| Search local files (text / AST) | `localSearchCode` |
| Browse local directory tree | `localViewStructure` |
| Find files by name/size/time | `localFindFiles` |
| Read a local file or range | `localGetFileContent` |
| Inspect archives / binaries | `localBinaryInspect` |
| Symbol identity, refs, callers, types | `lspGetSemantics` |
| Resolve npm package to source | `npmSearch` |
| See a local image / screenshot (vision) | `readImage` |
| Show an authored graphic inline (svg / html) | `createImage` |
| Single-shot Chrome DevTools call | `chromeDebug` |
| Browser analysis routing | `browserAgent` |
| Multi-turn browser session | `browserAgent(...)` → `spawnAgent(...)` → `AgentMessage(...)` |
| Spawn background Pi worker | `spawnAgent` |
| Coordinate spawned workers | `AgentMessage` |
| Fetch a URL / web search | `web` |
| List / call an external MCP server tool | `MCPTool` |
| Add / remove / restart an MCP server (no agent restart) | `MCPTool` (action: add/remove/restart) |

> **Built-in `octocode` server** (`npx -y octocode-mcp@latest`) is the default MCP and **cannot be removed** (`action:remove octocode` is refused); you may override its config with `action:add`. The discovery cache has a **10-minute TTL** (plus event-based invalidation), and the live connect path is covered by a gated integration test (`RUN_MCP_LIVE=1`). mcp.json (global + project) is **watched for external edits** and hot-reloaded automatically (stale connections + cache dropped, user notified) — no agent restart.
| Reuse/create/maintain a verified dynamic capability | `callTool` |
| Reuse/create/maintain a reusable multi-step workflow | `callSkill` |
| Compact / reset context | `manage_context` |
| Recall prior lessons | `memory` tool or `npx @octocodeai/octocode-awareness-lite memory recall` (CLI) |
| Record a root cause / decision | `memory` tool or `npx @octocodeai/octocode-awareness-lite memory store` (CLI) |
| Leave a continuation note | `npx @octocodeai/octocode-awareness-lite handoff add` (CLI) |
| Check locks + active agents | `npx @octocodeai/octocode-awareness-lite status` (CLI) |
| Send / read tiny messages | `npx @octocodeai/octocode-awareness-lite message …` (CLI) |
| Protect sensitive files exclusively | `npx @octocodeai/octocode-awareness-lite lock acquire` (CLI) |

---

## Core Tools

### `bash`
Execute shell commands in the current working directory. Octocode override of Pi’s built-in bash: same shell execution, plus path-guard on redirect/`tee`/`cp`/`mv` write targets and a small blocklist of catastrophic commands. Every call requires a non-empty `reasoning` field explaining why the command is necessary. Returns stdout + stderr (truncated to last 2 000 lines / 50 KB). Prefer `edit`/`write` for ordinary file mutations; use bash for git, builds, `sed`/bulk edits, and anything local tools cannot cover. Details: [OVERRIDES.md](./OVERRIDES.md).

### `edit`
Targeted file replacement using exact current-file text. Detects stale reads before writing. Every edit requires a non-empty `reasoning`. Use `matchMode:"normalized"` for whitespace drift; `matchMode:"lineRange"` with freshly read line numbers as a last resort. **Not** for new files — use `write`. Diff previews use Myers line diff (see [OVERRIDES.md](./OVERRIDES.md)).

### `write`
Create or overwrite a file. Octocode override of Pi’s built-in write: same create/overwrite + parent-mkdir semantics, plus path-guard (cwd / home / OS temp / `ALLOWED_PATHS`) and post-write read-state recording for the edit stale-check. Every call requires a non-empty `reasoning` field explaining why the create/overwrite is necessary. No match guard — overwrites without confirmation. Use only for new files or intentional full rewrites; prefer `edit` for surgical changes. Details: [OVERRIDES.md](./OVERRIDES.md).

---

## GitHub Tools

All accept `{ queries: [...] }` (up to 5 parallel). Support `page`, `responseCharOffset`, `responseCharLength`.

| Tool | Key params | Notes |
|------|-----------|-------|
| `ghSearchCode` | `keywords`, `owner`, `repo`, `match`, `extension`, `path`, `page` | `match:"path"` for filenames; `match:"file"` for snippets |
| `ghSearchRepos` | `keywords`, `language`, `stars`, `sort`, `concise` | Start `concise:true`; follow into `ghViewRepoStructure` |
| `ghHistoryResearch` | `type`, `owner`, `repo`, `prNumber`, `content`, `state` | `type:"prs"` or `type:"commits"`; detail mode needs `prNumber` |
| `ghGetFileContent` | `owner`, `repo`, `path`, `startLine`/`endLine`, `matchString`, `minify`, `branch` | `symbols` → anchor → `none` for edits |
| `ghViewRepoStructure` | `owner`, `repo`, `path`, `maxDepth`, `branch` | Orient before fetching files |
| `ghCloneRepo` | `owner`, `repo`, `branch`, `sparsePath` | Needs `ENABLE_CLONE`; use `sparsePath` to bound checkout |

---

## Local Tools

All accept absolute paths. Strip leading `@` if copied from a Pi file reference.

| Tool | Key params | Notes |
|------|-----------|-------|
| `localViewStructure` | `path`, `recursive`, `maxDepth`, `pattern`, `extensions` | Cheapest orientation step; use before any file read |
| `localSearchCode` | `path`, `keywords`, `mode`, `perlRegex`, `fixedString`, `include`, `contextLines` | Modes: `discovery` · `paginated` · `detailed` · `structural` (AST) |
| `localFindFiles` | `path`, `names`, `regex`, `entryType`, `maxDepth`, `modifiedWithin` | Name/size/time filters; use when content doesn't matter |
| `localGetFileContent` | `path`, `startLine`/`endLine`, `matchString`, `minify`, `fullContent` | `symbols` first for large files; `none` for edits/citations |
| `localBinaryInspect` | `path`, `mode` | Modes: `inspect` · `list` · `extract` · `decompress` · `strings` · `unpack` |

**`localSearchCode` modes:**

| Mode | Use |
|------|-----|
| `discovery` | Paths only — cheapest; find candidates before reading |
| `paginated` | Snippets with surrounding context |
| `detailed` | Full context window |
| `structural` | AST pattern (`pattern`) or rule (`rule`); captures feed `lspGetSemantics` |

---

## LSP Tool

### `lspGetSemantics`

Symbol-level code intelligence. `lineHint` **must** come from a prior search result, `matchRanges`, or `documentSymbols` — never guessed.

| Operation | When to use |
|-----------|------------|
| `definition` | Jump to declaration |
| `references` | All usages of a symbol |
| `callers` / `callees` | Call hierarchy one level |
| `callHierarchy` | Full call graph (use `depth`) |
| `hover` | Type info + docs at a location |
| `documentSymbols` | All symbols in a file (no `lineHint` needed) |
| `workspaceSymbol` | Fuzzy project-wide symbol search |
| `typeDefinition` | Follow to type declaration |
| `implementation` | Find interface implementations |
| `supertypes` / `subtypes` | Type hierarchy |
| `diagnostic` | File-level errors/warnings (no `lineHint` needed) |

---

## Package Tool

### `npmSearch`
Resolve npm package names → GitHub repo. Exact package name returns rich single result with `repository`. Keyword query returns paginated candidates. Follow `repository` into GitHub tools.

---

## Browser Tools

See [`BROWSER_AGENT.md`](https://github.com/bgauryy/octocode-mcp/blob/main/packages/octocode-pi-extension/subagents/browser-agent/BROWSER_AGENT.md) for the full 28-scheme reference, stealth mode, multi-turn protocol, and CDP event log.

### `chromeDebug`
Direct Chrome DevTools Protocol calls. One scheme per call. Use for single-shot tasks.

```
chromeDebug scheme:"debug" url:"https://example.com" port:9222 launch:true
chromeDebug scheme:"screenshot" port:9222 format:"png" fullPage:true
chromeDebug scheme:"raw" method:"Network.getCookies" params:{"urls":["https://example.com"]}
```

Key params: `scheme` (required), `url`, `port` (default 9222), `launch`, `headless`, `stealth`, `durationMs`.

### `browserAgent`
Routes a natural-language browser task to the right CDP scheme(s), runs initial analysis, and returns a spawn config for a dedicated `browser-agent` subagent. Use when the task type is unclear; the tool selects the optimal schemes.

### `spawnSubagent`
Spawn a typed, pre-configured Pi subagent. Supported agents are:

|Agent|Use|
|---|---|
|`browser-agent`|Multi-turn Chrome DevTools work: security, network, DOM, coverage, workers, emulation, automation.|
|`researcher`|Evidence gathering across web, GitHub, npm, local files, binaries, and LSP.|
|`planner`|Dependency-ordered implementation plans, risks, verification strategy, and RFC handoffs.|
|`architect`|Root-cause and architecture analysis with local/LSP/binary tools, history, web, and targeted bash.|

```
spawnSubagent({
  agent: "browser-agent",
  task: "audit cookies on https://example.com",
  url: "https://example.com",
  port: 9222,
  launch: true
})
→ agentId: "abc123"
AgentMessage({action:"wait", agentId:"abc123", timeoutMs:60000})
AgentMessage({action:"kill", agentId:"abc123", remove:true})
```

Params: `agent`, `task`, `context`, `url`, `port`, `launch`, `headless`, `model`, `provider`, `thinking`, `name`, `cwd`. `url`, `port`, `launch`, and `headless` apply to `browser-agent`; other agents ignore browser-only params.

---

## Agent Tools

### `spawnAgent`
Spawn a background Pi worker process. Returns `agentId` immediately. Prompt must be **self-contained** — worker has zero parent context.

Key params: `task`, `prompt`, `context`, `name`, `cwd`, `model`, `provider`, `thinking`, `tools`, `systemPrompt`, `resourceMode` (`lean` / `octocode` / `default`), `noSession`.

Spawn policy is centralized and warning-first: packets should include goal, scope, ownership, acceptance, and return shape; Claude/custom-provider model IDs should pass `provider` from `pi -ne --list-models`; recursive worker tools are stripped. The hard active-worker cap still blocks spawns before a process is created. Defaults can be tuned with `OCTOCODE_AGENT_MAX_ACTIVE` and `OCTOCODE_AGENT_WARNING_ACTIVE`.

`FORBIDDEN_WORKER_TOOLS`: `spawnAgent`, `AgentMessage`, `spawnSubagent` — workers cannot spawn sub-workers.

### `/octocode`
Top-level dashboard for users: status, live agents, setup paths, bundled skills, health warnings, and next actions. It is the fastest way to confirm the extension is active.

### `/octocode-agents`
Interactive command for the in-session worker ledger. It updates the Octocode agents footer/widget and sends a compact notification. Recovery-risk badges (`⚠ recovery`, `⚠ needs verify`) appear in list output and the widget. Maintainer architecture and Pi SDK mapping are documented in [`AGENT_ORCHESTRATOR.md`](./AGENT_ORCHESTRATOR.md).

|Command|Use|
|---|---|
|`/octocode-agents help`|Show examples, lifecycle hints, and id-prefix guidance|
|`/octocode-agents` or `/octocode-agents list`|List worker id, name, status, handback, active tool, age, and output preview|
|`/octocode-agents status`|Refresh status/widget and show the ledger|
|`/octocode-agents inspect <id-or-prefix>`|Show one worker's full status, normalized handback, evidence, policy warnings, and output preview|
|`/octocode-agents kill <id-or-prefix>`|Terminate one worker by full id or readable prefix|
|`/octocode-agents kill-all`|Terminate all non-terminal workers|
|`/octocode-agents prune`|Remove terminal worker records from the in-session ledger|
|`/octocode-agents hide`|Clear the footer/widget for this session|

Slash completions expose these subcommands with action-specific descriptions.

Worker handbacks are normalized from typed prefixes like `[EVIDENCE]`, `[VERIFICATION]`, `[CONFIDENCE]`, `[BLOCKED]`, `[DONE]`, and `[FAILED]`. Raw output remains available through `AgentMessage` details/expanded result.

### `AgentMessage`
Coordinate spawned workers. Always set explicit `timeoutMs` on `wait`.

| Action | Use |
|--------|-----|
| `list` | Show all registered agents + status |
| `status` | Poll one agent without blocking |
| `wait` | Block until agent reaches `idle`/`exited`/`failed` |
| `send` | Start the next turn on an idle worker; queues behind an in-flight turn |
| `steer` | Redirect a running turn after its current tool calls, before the next model step (idle workers: queued like `followUp`) |
| `followUp` | Queue after current completion |
| `abort` | Graceful stop; process stays alive |
| `kill` | Hard terminate + optional `remove:true` |

Agent lifecycle: `starting` → `running` → `idle` → `exited` / `failed` / `killed`.

---

## Media Tools

Inline images require a terminal that speaks the Kitty graphics or iTerm2 protocol
(Kitty, Ghostty, WezTerm, Warp, iTerm2). On VS Code / tmux / plain xterm the tools
fall back to a saved PNG plus a text placeholder and an offer to open it in a
browser — the agent must ask the user first and never auto-opens.

### `readImage`
Load a local image (`png`/`jpeg`/`gif`/`webp`, ≤ 4MB) and return it as an image
content block so a vision-capable model can see it; pi renders it inline in
image-capable terminals. Does no OCR itself — the model reads the pixels.

```
readImage path:"./.octocode/screenshots/login.png"
```

### `createImage`
Render agent-authored markup to a PNG shown inline. Two modes (provide exactly one):
- `svg` — rasterized with `@resvg/resvg-js` (Rust, no browser; system fonts loaded).
- `html` — rendered by headless Chrome (full CSS/flex/grid/gradients/webfonts/emoji); requires Chrome installed.

Optional: `width`, `height` (html only), `background`, `name`, `saveTo`,
`showToModel` (default false — keeps the image out of model context). Max 4MB output.

```
createImage svg:"<svg xmlns='http://www.w3.org/2000/svg' width='120' height='40'>…</svg>"
createImage html:"<div style='display:flex;gap:8px'>…</div>" width:800 background:"#0d1117"
```

---

## Web Tool

### `web`
Fetch a URL as clean text or run a web search. Use `url` to fetch, `query` to search.

Key params: `url`, `query`, `maxResults` (default 5), `maxChars`, `page`, `timeRange`, `includeDomains`, `excludeDomains`, `engine`.

Use for: live docs, error messages, changelogs, current info beyond the codebase.

---

## Context Tool

### `manage_context`
Compact or reset the conversation context.

| Type | When |
|------|------|
| `compact` | ≥ 60% full, at research→execution boundary, before large task, after writing handoff doc |
| `new` | Next task is fully unrelated to current conversation |

Param: `instructions` — focus hint for compaction summary (used with `compact` only).

If Pi reports `Nothing to compact`, the extension treats it as a benign no-op and reports `Compaction skipped: session is too small to compact.` No continuation is queued.

A model-runtime `maximum output token limit` stop is different from context pressure: the answer was too large for one response. The extension does not auto-compact/retry that stop; continue with a shorter/chunked response or write long output to a file and return a concise summary plus path.

---

## Internal error log

The extension appends extension-visible errors to repo-local `.octocode/logs/error.txt`:

- user-visible extension `error` notifications;
- hook middleware exceptions;
- tool executions that end with `isError: true`;
- provider responses with HTTP status `>= 400`.

Each entry includes timestamp, process uptime, source, cwd, Pi mode, model id/reasoning, context usage when available, duration for tool/provider failures, redacted details, stack, and cause. Secret-like fields (`authorization`, `cookie`, `token`, `secret`, `password`, API keys, credentials) are redacted before writing.

Pi-core/runtime banners that do not pass through extension hooks, such as a model-runtime `maximum output token limit` stop, may still require Pi-side logging.

---

## Memory / Awareness (memory tool + CLI + skill)

Awareness coordination has **no agent tools**. Drive status/plan/task/work/lock/
handoff/check/message through `npx @octocodeai/octocode-awareness-lite <noun> <verb>`
(pass workspace/agent flags where a command needs them), following the
**octocode-awareness-lite skill**. Pi only automates the pre-edit lock gate;
agents run task/work/check commands explicitly.

Memory is the deliberate exception: the `memory` tool is a small wrapper over the
same Lite memory CLI for recall/record/forget. Use either surface, but keep
coordination on the CLI so there is one task/work/check schema.

See [`AWARENESS_AGENT_FLOW.md`](https://github.com/bgauryy/octocode-mcp/blob/main/packages/octocode-pi-extension/docs/AWARENESS_AGENT_FLOW.md) for live coordination, [`REFLECT.md`](https://github.com/bgauryy/octocode-mcp/blob/main/packages/octocode-pi-extension/docs/REFLECT.md) for Lite memory guidance, and [`CRON.md`](./CRON.md) for session job controls.

### Lifecycle pattern

```
[Awareness/start] status → targeted memory recall when useful
[Awareness/work]  message send / handoff add (coordination notes, questions, blockers)
                 lock acquire              (optional sensitive-path exclusivity)
[Awareness/after] check audit → run the declared check → check mark <exact-owned-task>
[Awareness/learn] memory store (verified root causes, decisions, gotchas)
```

### CLI quick-reference

| Command | Purpose |
|------|---------|
| `memory recall` | Retrieve durable lessons before risky/unfamiliar work; flags `judgment_required` when recall confidence is low |
| `memory store` | Store verified root cause, decision, workaround, or gotcha |
| `memory list\|forget\|delete\|prune` | Inspect or explicitly remove stale memories |
| `status` | Show plans, tasks, locks, work presence, agents, messages, handoffs, checks, and memory counts |
| `message send\|inbox\|list\|read\|prune` | Tiny coordination inbox |
| `handoff add\|list\|clear` | Manual continuation notes for later agents |
| `lock acquire\|release\|list` | Optional exclusive protection for sensitive paths |
| `check audit` | List done tasks still needing check receipts |
| `check mark` | Mark one exact owned task verified after its declared check; never batch another agent's work. |

## MCP Servers

`MCPTool` is a dedicated stdio MCP client built into the extension. It lets the
agent list, describe, and call tools exposed by any Model Context Protocol server
— without those tools being registered individually in Pi. `/mcp` is a slash-command
alias for the MCP status/management UI; it is not a model-callable tool alias.

The built-in `octocode` research server is always available (pinned local `octocode-mcp`,
`npx -y octocode-mcp@latest` fallback). Add your own servers by dropping an `mcp.json` file
in one of the config locations below — **no code change or rebuild is needed.**

Once init discovery lands, a machine-readable inventory is written to
`.octocode/discovery.json`: every discovered skill (scanned across the common ecosystem
roots — `.agents`, `.claude`, `.cursor`, `.codex`, `.octocode`, `.pi` in project and user
scope, deduped by name), the active MCP servers + tools, and every MCP config file found
in the common locations (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, …).
Foreign configs are inventory only — never auto-spawned; opt in via `MCPTool action:add`.

At session init every configured server is fully discovered — its instructions, tools,
and exact input schemas — and injected into the system prompt as a `<mcp_catalog>` block.
The block is byte-stable across turns (provider prompt caching pays for it once) and
refreshes only when the config actually changes (mcp.json edit, `add`/`remove`/`restart`,
`tools/list_changed`). The model calls tools straight from the catalog; `list`/`describe`
are only needed for truncated entries or failed schema validation.

### 1. Where config is read from

Servers are merged from three sources, later overriding earlier by server name:

| Precedence | Scope | Path | Loaded when |
|---|---|---|---|
| 1 | built-in | `npx -y octocode-mcp@latest` | always (`octocode` server) |
| 2 | global | `~/.pi/agent/mcp.json` | if the file exists |
| 3 | project | `<workspace>/.pi/agent/mcp.json` | only if the project is **trusted** |

Untrusted project configs are skipped with a warning (they never spawn a process).
Run `MCPTool({action:"config"})` to see the resolved servers, sources, and warnings.

### 2. Config file format

JSON with a `mcpServers` object (a bare `servers` object or a top-level name→config map
also work). Each server entry:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@acme/mcp-server@latest"],
      "env": { "ACME_TOKEN": "..." },
      "cwd": "./sub/dir",
      "timeoutMs": 30000,
      "disabled": false,
      "description": "Acme knowledge base"
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `command` | yes | Executable to spawn (stdio transport). |
| `args` | no | Array of string arguments. |
| `env` | no | Extra environment vars, merged over `process.env`. |
| `cwd` | no | Working dir; relative paths resolve from the workspace and are path-guarded. |
| `timeoutMs` | no | Per-request timeout, clamped `1000..120000` (default `30000`). |
| `disabled` | no | `true` skips the server entirely. |
| `description` | no | Human label shown in `list`/`config`. |

Server names must match `^[A-Za-z0-9_.-]{1,64}$`. A user entry named `octocode` overrides
the built-in one (its `env` still gets the full-text + npm-cache defaults merged in).

### 3. Using MCP tools

`MCPTool` is a tool bridge, not a worker — no planning, memory, or synthesis. Actions:

| Action | Purpose |
|---|---|
| `list` | List servers (or one server's tools + schemas). Populates the catalog. |
| `describe` | Full schema for one `server`/`tool`. |
| `call` | Invoke `server`/`tool` with `arguments`. |
| `status` | Show configured vs. running servers. |
| `config` | Show resolved config sources + warnings. |
| `restart` | Stop and relaunch one `server`. |
| `stop` | Stop one `server`, or all if omitted. |

```jsonc
// discover what a server offers (also refreshes the cached catalog)
MCPTool({ action: "list", server: "my-server" })

// inspect one tool's exact schema before calling
MCPTool({ action: "describe", server: "my-server", tool: "searchDocs" })

// call it
MCPTool({ action: "call", server: "my-server", tool: "searchDocs",
          arguments: { query: "retry policy" } })
```

Servers are spawned at session init for catalog discovery (best-effort, never blocks
startup) and reused for the session; `stop`/`restart` recycle them and a later `list`/
`call` respawns on demand. Treat any MCP server as arbitrary code — only add config you trust.

---

## Configuration

| Variable | Effect |
|----------|--------|
| `OCTOCODE_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | GitHub authentication (priority order) |
| `GITHUB_API_URL` | GitHub Enterprise API base URL |
| `ENABLE_LOCAL` | Set `false` to disable all local tools |
| `ENABLE_CLONE` | Enables `ghCloneRepo` + `ghGetFileContent(type:"directory")` |
| `OCTOCODE_CDP_DEBUG` | Set `1` to write CDP events to `~/.octocode/chrome-debug/port-<N>/cdp-events.jsonl` |

Loaded via `@octocodeai/config`. Run `npx @octocodeai/config --keys` to inspect active values.

---

## Schema Lookup

```bash
# Exact active schema for any tool
node $OCTOCODE_CLI tools <toolName> --scheme

# List all 13 Octocode tools
node $OCTOCODE_CLI tools
```

---

## callTool — self-extending dynamic tools

`callTool` is a meta-tool: request a capability by name and it reuses, creates (with
approval), or maintains a verified **dynamic tool**. Dynamic tools are self-contained
scripts persisted under `getOctocodeHome()/dynamic-tools/`, executed in an isolated Node
subprocess — never registered as first-class Pi tools at runtime.

### Schema
- `toolType` — logical capability name; the O(1) registry key (e.g. `parseCronExpression`).
- `metadata` — runtime args **plus** reserved keys:
  - `intent` — what a new tool should do (used to generate a miss).
  - `reason` — **required to create**: why a persisted reusable tool is justified.
  - `_allow` — approve capabilities, e.g. `["net"]`.
  - `_force` — override the triviality decline.
  - `_approveCreate` — approve creation in `auto` mode without switching to `create`.
  - `_sandboxed` — set `false` to approve creating a NON-sandboxed trusted tool (rare).
- `mode` — `auto` (default: reuse, else propose) · `run` (reuse only) · `create` (generate
  after approval) · `enhance`/`fix` (regenerate existing) · `list` · `delete`.

### Lifecycle
1. **Resolve** — exact name (O(1)) → keyword/description fallback.
2. **Reuse** — run the resolved tool in a sandboxed subprocess.
3. **Propose** — on an `auto` miss, callTool does **not** silently generate. It returns a
   proposal: research (built-in? library? existing tool? one-line command?), brainstorm the
   smallest design, then **ask the user** and re-call with `mode:"create"` + `reason`.
4. **Create** — a tool-smith subagent generates `tool.mjs` + `tool.test.mjs`; registered
   **only if the test passes** (verification gate).
5. **Maintain** — every call prunes unambiguous junk (missing / always-failing tools).

### Guardrails
- **Triviality guard** — a tool must optimize the agent, not bloat it. If a one-line shell
  command already covers it (`date`, `uuidgen`, `base64`, `wc`, `shasum`, `jq`, …), creation
  is declined with the suggested command (override via `metadata._force:true`).
- **Verification gate** — no green test → no registry entry. No stubs.
- **Enforced sandbox (default)** — sandboxed tools run under the **Node permission model**
  (`--permission`): filesystem, network, and child processes are **denied by default** and
  `process.env` is **scrubbed** to a minimal `PATH`. Declared capabilities are *enforced*,
  not advisory — a tool that didn't declare `net`/`fs`/`exec` physically cannot use them
  (`net`→`--allow-net`, `exec`→`--allow-child-process`, `fs`→broad fs read/write). Native
  addons, workers, FFI, and the inspector are never granted. Plus a hard timeout and sha256
  checksum tamper-check on every run.
  Runtime code generation (`eval`/`new Function`) is disabled
  (`--disallow-code-generation-from-strings`), and `metadata` is delivered on **stdin**
  (never argv) so large inputs never hit OS argument limits.
- **`sandboxed` flag (not all tools need it)** — recorded in the manifest (default `true`).
  A trusted tool that needs broad host access can be created with `sandboxed:false`, but only
  when the caller approves via `metadata._sandboxed:false`; it then runs as an ordinary Node
  process with inherited env.
- **Capability approval** — `net`/`fs`/`exec` also require `metadata._allow` at call time, so
  both declaration (manifest) and approval (caller) must agree before a capability is granted.
- **Mandatory reason** — every created tool records why it should exist.
- **Deterministic result cache** — a tool created with `deterministic:true` and no capabilities memoizes results per (name, version, metadata); repeat calls skip the subprocess (`[REUSED …, cached]`). Re-registering a new version busts the cache.
- **Awareness projection** — a live `<dynamic_capabilities>` block is injected into the system prompt each turn (empty when no dynamic tools/skills exist), so the agent knows its self-created tools/skills without an explicit `list`. Rebuilt from disk per turn — no watcher.
- **Concurrency + rollback** — registry writes take a cross-process lock (shared under
  `getOctocodeHome()` across parallel agents); a failed `enhance`/`fix` rolls back to the
  previous good tool, so there is never a soft-broken (stale-checksum) state.

### CRUD
- Read: `mode:"list"`. Delete: `mode:"delete"` (with `toolType`). Update: `enhance`/`fix`.
- Auto-maintenance prunes junk on every call; the `[MAINTAINED]` line reports pruned tools.

Implementation: `src/tools/dynamic-tools.ts` (deterministic core) + `src/tools/call-tool.ts`
(orchestration + codegen). Dynamic **skill** creation is a planned sibling — see the
brainstorm in `.octocode/plans/*/SKILLS-BRAINSTORM.md`.

---

## callSkill — self-extending dynamic skills

`callSkill` is the workflow sibling of `callTool`. A **dynamic skill** is an approved,
reusable multi-step workflow the agent follows: a `SKILL.md` (Agent Skills frontmatter +
ordered steps) plus optional helper files, written to `~/.pi/agent/skills/<name>/` so Pi
discovers it. **Skills orchestrate; `callTool` executes** — any executable helper a skill
ships should run through the callTool sandbox.

### Schema
- `skillType` — skill/workflow name (lowercase `a-z`, `0-9`, hyphens); O(1) registry key.
- `metadata` — reserved keys: `intent` (what the workflow does), `reason` (**required to
  create**), `_approveCreate` (approve in `auto` mode), `_force` (override triviality decline).
- `mode` — `auto` (reuse, else propose) · `use` (reuse only) · `create` (author after
  approval) · `enhance`/`fix` · `list` · `delete`.

### Lifecycle & guardrails (mirrors callTool)
1. **Resolve** exact name (O(1)) → keyword fallback.
2. **Reuse** — returns the `SKILL.md` path + `/skill:<name>` to follow.
3. **Propose** — on an `auto` miss it does **not** silently author; it asks you to research
   (existing skill/tool/command?), brainstorm the smallest workflow, and get user approval.
4. **Create** — a skill-smith subagent authors `SKILL.md`; registered **only if it passes
   frontmatter + structure validation** (the skill verification gate; softer than a tool's
   test gate, so lean on approval + rubric).
5. **Maintain** — every call prunes broken skills (missing/invalid `SKILL.md`).

- **Triviality guard** — a skill must be a *recurring multi-step workflow*, not a one-off a
  single tool/bash/`callTool` covers (override via `metadata._force:true`).
- **Mandatory reason** — every created skill records why it should exist.
- **Discovery** — spawned subagents see a new skill immediately (their skill dirs re-scan per
  spawn); the main process surfaces it after a reload or by `read`ing the returned path.

Implementation: `src/tools/dynamic-skills.ts` (deterministic core: resolve/validate/register/
delete/sweep) + `src/tools/call-skill.ts` (orchestration + skill-smith authoring).
