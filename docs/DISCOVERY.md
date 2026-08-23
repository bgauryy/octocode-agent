# Octocode Harness — Capability Discovery, MCP Catalog, Skills & Observability

How the Octocode Pi extension (`@octocodeai/pi-extension`) discovers everything the
agent can do — MCP servers, Agent Skills, native tools — injects it into the model's
context for smart prompt caching, and makes all of it observable to users and peer
agents.

All sizes and examples below are real, measured against the built package.

---

## 1. The big picture

```
session_start
 ├─ warmMcpCatalog()            connect EVERY configured MCP server,
 │                              cache instructions + tools + exact input schemas
 ├─ …once discovery lands…
 │   └─ writeDiscoveryFile()    .octocode/discovery.json — machine-readable
 │                              inventory: skills + MCP configs + native tools
 └─ startMcpConfigWatcher()     hot-reload mcp.json edits (no restart)

before_agent_start (every turn)
 ├─ await mcpCatalogReady()     bounded wait so TURN 1 already has the catalog
 ├─ stripPiSkillsSection()      Octocode owns the skill flow (see §3)
 └─ system prompt = Pi prompt
      + static Octocode prompt      (~26.7k chars ≈ 6.7k tokens)
      + <mcp_catalog>               (~61.5k chars ≈ 15.4k tokens, byte-stable)
      + <dynamic_capabilities>      (self-created tools/skills, usually empty)
      + <available_skills>          (~2k chars, live skill catalog)
      + <active_plan>               (compaction-durable plan state)
```

Design rule everywhere: **stable bytes**. Everything injected per turn is
byte-identical across turns unless the underlying capability genuinely changed —
that is what makes provider prompt caching pay for the large catalog once per
cache window instead of every turn.

---

## 2. MCP: full discovery at init, `<mcp_catalog>` in the prompt

Source: `packages/octocode-pi-extension/src/tools/mcp-tool.ts`

### Config sources (loaded, in override order)

| Precedence | Scope | Path | Loaded when |
|---|---|---|---|
| 1 | built-in | pinned local `octocode-mcp` (npx fallback) | always (`octocode` server, cannot be removed) |
| 2 | global | `~/.pi/agent/mcp.json` | if the file exists |
| 3 | project | `<workspace>/.pi/agent/mcp.json` | only if the project is trusted |

### Init discovery

`warmMcpCatalog()` runs at `session_start`: it connects every configured server and
caches its **instructions, tool list, and exact `inputSchema` JSON**. It is deduped
per workspace and awaitable — `before_agent_start` calls `mcpCatalogReady()`
(bounded, 10s, never spawns servers itself) so the catalog is in the **first**
turn's prompt. A catalog that first appeared on turn 2 would change the prompt
prefix and invalidate the provider cache for the whole session.

### The `<mcp_catalog>` block

Injected every turn (survives compaction). Contents per server:

```
server: octocode
instructions: <full server instructions, cap 4,000 chars>
tool: ghSearchCode
description: <full description, cap 2,000 chars>
inputSchema: {"type":"object","required":["queries"],…}   ← exact, compact JSON, cap 8,000 chars
tool: …
```

- The built-in `octocode` server is listed **first** and the header names it the
  default research surface.
- Caps are a safety net against rogue servers (80,000 chars/server), not a
  compaction strategy — the full octocode server (14 tools, ~60k chars ≈ 15k
  tokens) fits untruncated. Truncation is always explicit and actionable
  (`…[schema truncated — run MCPTool describe server:X tool:Y …]`).
- **Byte-stability contract** (pinned by tests): no timestamps, no fresh/stale
  labels, no usage-dependent schema inlining. The block's bytes change only when
  the MCP config actually changes: an `mcp.json` edit (file watcher hot-reloads),
  `MCPTool add/remove/restart/stop`, or a server's `tools/list_changed`
  notification.

The model calls tools straight from the catalog — no list/describe round-trip:

```
MCPTool({action:"call", server:"octocode", tool:"ghSearchCode",
         arguments:{queries:[{keywords:["…"]}]}})
```

`list`/`describe` remain for truncated entries or failed schema validation.
`add`/`remove`/`restart`/`stop` manage servers at runtime without an agent restart
(global adds require interactive user approval; project writes require a trusted
project).

### TUI observability

- Request row: `◇ localSearchCode · [text] "query" in path` (branded octocode
  renderer) or `mcp <action> · <server>/<tool>` for other servers.
- Response row: `✓ localSearchCode` collapsed; expand (ctrl+o) for the structured
  result tree; errors render in error styling; in-flight shows `running…`.
- Footer: MCP server/tool counts + per-turn prompt overhead live in the branded
  toolbar (`/octocode-status` → prompt budget lists every block's size).

---

## 3. Skills: Octocode owns the model-facing flow

Sources: `packages/octocode-pi-extension/src/tools/skill-tool.ts`,
`skill-catalog.ts`, `src/prompt.ts` (`stripPiSkillsSection`)

### Why Pi's flow is disabled

Pi's native flow advertises skills in its system prompt and tells the model to use
the `read` builtin to load `SKILL.md` — Pi's own docs note "models don't always do
this". Octocode removes the weak `read` builtin entirely, so that instruction is a
dead end, and Pi's section uses the same `<available_skills>` tag as Octocode's
(duplicate catalogs). The extension therefore **strips Pi's skills section from
the prompt deterministically** every turn (`stripPiSkillsSection`), regardless of
tool-set timing. The user-facing `/skill:<name>` command is untouched.

### The `skill` tool (the Claude Code / agentskills.io pattern)

| Call | Returns |
|---|---|
| `skill({action:"load", name:"…", reason:"why it matches"})` | Full `SKILL.md` (cap 48k, explicit truncation pointer) + skill directory + shipped files, with "resolve relative paths against this directory". The default action requires a concise, user-facing `reason`. Names have a case-insensitive fallback. |
| `skill({action:"list"})` | Every discovered skill with source tag and session usage (`loaded 2× this session`). |

Loads are recorded in a per-session **usage ledger** — shown in `skill list` and the
`/octocode-skills` dashboard ("Loaded this session"). The TUI renders one branded call
row that explains the trigger
(`◆ skill · octocode-research why: the task needs repository evidence`). Successful
result rows stay hidden; errors remain visible.

### Skill discovery — common roots, deduped by name

`discoverSkills()` merges (first match per **name** wins):

1. **Pi's live catalog** (`systemPromptOptions.skills`) — session authority.
2. **Project roots**: `.agents/skills` (vendor-neutral standard, labeled
   `project`) · `.claude/skills` · `.cursor/skills` · `.codex/skills` ·
   `.octocode/skills` · `.pi/agent/skills` · `.pi/skills` (labeled
   `project:<host>`).
3. **User roots**: `~/.pi/agent/skills` (labeled `user`) · `~/.pi/skills` ·
   `~/.claude/skills` · `~/.cursor/skills` · `~/.codex/skills` ·
   `~/.octocode/skills` (labeled `user:<host>`).
4. **Extension-bundled** skills (labeled `bundled`).

A directory counts as a skill iff it contains `SKILL.md`; `name`/`description`
come from its frontmatter (directory name fallback). Any skill from any of these
locations is directly loadable by the agent.

### Prompt integration

- `<available_skills>` (re-injected every turn, compaction-proof, budgeted: 30
  entries / 120-char descriptions, overflow points at `/octocode-skills`) teaches
  loading via the `skill` tool.
- The static prompt's `<skills>` section and `<ultimate_reminders>` name
  `skill({action:"load"…})` as THE loading mechanism.

---

## 4. The discovery file — `.octocode/discovery.json`

Source: `packages/octocode-pi-extension/src/tools/discovery-file.ts`

Written automatically at session start (right after MCP init discovery lands),
atomically, best-effort (a failed write never affects the session). Gitignored.
One file for users, peer agents, and external tooling to discover the whole
harness surface:

```jsonc
{
  "version": 1,
  "generatedAt": "2026-08-22T…",
  "workspace": "/Users/…/octocode-agent",
  "harness": "@octocodeai/pi-extension",
  "nativeTools": ["AgentMessage", "MCPTool", "askUser", "bash", "…"],   // sorted
  "skills": [
    { "name": "octocode-research", "description": "Use when code must be checked…",
      "source": "user", "path": "/Users/…/skills/octocode-research/SKILL.md" }
  ],
  "mcp": {
    "sources":  [ { "scope": "built-in", "path": "…", "trusted": true }, … ],
    "servers":  [ { "name": "octocode", "command": "…", "toolCount": 14,
                    "tools": [ { "name": "ghSearchCode", "description": "…" }, … ] } ],
    "warnings": [],
    "discoveredConfigs": [
      { "path": "~/.pi/agent/mcp.json",  "host": "pi",     "scope": "user",
        "format": "json", "active": true,  "servers": [{ "name": "octocode" }] },
      { "path": "~/.cursor/mcp.json",    "host": "cursor", "scope": "user",
        "format": "json", "active": false, "servers": [{ "name": "octocode" }] },
      { "path": "~/.codex/config.toml",  "host": "codex",  "scope": "user",
        "format": "toml", "active": false, "servers": [{ "name": "node_repl" }] }
    ]
  }
}
```

### MCP config discoverability (`mcp.discoveredConfigs`)

Every MCP config file found in the common ecosystem locations, project and user
scope:

| Host | Locations |
|---|---|
| claude | `<ws>/.mcp.json`, `<ws>/.claude/mcp.json`, `~/.claude/mcp.json` |
| cursor | `<ws>/.cursor/mcp.json`, `~/.cursor/mcp.json` |
| codex | `<ws>/.codex/config.toml`, `~/.codex/config.toml` (top-level `[mcp_servers.<name>]` tables; nested `.env` sub-tables are correctly skipped) |
| octocode | `<ws>/.octocode/mcp.json`, `~/.octocode/mcp.json` |
| pi | `<ws>/.pi/agent/mcp.json`, `~/.pi/agent/mcp.json` (**active**), `.pi/mcp.json` variants |

**Security boundary:** only the harness's own `.pi/agent/mcp.json` files are
`active: true` (actually loaded). Foreign configs are inventory only — an MCP
server is arbitrary local code, so nothing discovered elsewhere is ever
auto-spawned. Opting in is explicit: `MCPTool({action:"add", server, config, scope})`.
Malformed files are reported with an `error` field, never thrown.

---

## 5. What is in the model's context (measured)

Per-turn Octocode system-prompt addendum, stable → volatile order:

| # | Block | Size (real run) | Changes when |
|---|---|---|---|
| 1 | Static Octocode prompt | 26,672 chars ≈ 6.7k tok | package release |
| 2 | `<mcp_catalog>` | 61,457 chars ≈ 15.4k tok | MCP config change only |
| 3 | `<dynamic_capabilities>` | 0 (until created) | callTool/callSkill registry change |
| 4 | `<available_skills>` | ~2k chars | skill install/removal |
| 5 | `<active_plan>` | 0 (until `plan(set)`) | plan progress |
|  | **Total** | **~90k chars ≈ 22.5k tok** | mostly prompt-cached |

The table measures only Octocode system-prompt addenda. It excludes Pi's base
prompt, cwd/project context, API `tools` definitions, and conditional extras such
as a `<repo_state>` git snapshot when the user's message mentions repo-, diff-,
or branch-related words.

Native tool definitions (`edit`, `write`, `bash`, `skill`, `MCPTool`, `web`,
`plan`, `askUser`, `memory`, `callTool`, `callSkill`, `spawnAgent`,
`spawnSubagent`, `AgentMessage`, `readImage`, `createImage`, plus `chromeDebug`
and `browserAgent` when Chrome debugging is enabled) ride in the API `tools`
parameter, so the footer budget does not include them. The Octocode research
tools deliberately do **not** ride as native API tools; they ride through
`MCPTool`, with their schemas in `<mcp_catalog>`.

Live view: the footer's overhead segment and `/octocode-status` (prompt budget)
show the Octocode system-prompt addenda per turn.

---

## 6. Where things live

| Concern | Source | Tests |
|---|---|---|
| MCP client, catalog, discovery snapshot | `packages/octocode-pi-extension/src/tools/mcp-tool.ts` | `tests/mcp-tool.test.ts`, `tests/package.test.ts` |
| `skill` tool + skill discovery + usage ledger | `packages/octocode-pi-extension/src/tools/skill-tool.ts` | `tests/skill-tool.test.ts` |
| Skill catalog UI (prompt block + dashboard) | `packages/octocode-pi-extension/src/tools/skill-catalog.ts` | `tests/skill-catalog.test.ts` |
| Discovery file + MCP config discoverability | `packages/octocode-pi-extension/src/tools/discovery-file.ts` | `tests/discovery-file.test.ts` |
| Prompt composition + Pi-section strips | `packages/octocode-pi-extension/src/prompt.ts`, `src/prompts/prompt.ts` | `tests/prompt-dedup.test.ts` |
| Session wiring (init discovery, turn-1 await, dashboards) | `packages/octocode-pi-extension/src/index.ts` | `tests/package.test.ts` |

Related package docs: `packages/octocode-pi-extension/docs/TOOLS.md` (tool
reference, MCP section), `docs/UI.md` (TUI surfaces).
