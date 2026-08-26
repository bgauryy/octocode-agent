# Octocode harness — capability discovery, MCP catalog, skills, and observability

How the Octocode Pi extension (`@octocodeai/pi-extension`) discovers everything the
agent can do—MCP servers, Agent Skills, and native tools—while keeping model-visible
catalog bytes stable and making the capability surface observable to users and peers.

Character and latency measurements below use the deterministic fixture documented in
`.octocode/rfc/lazy-mcp-schema-hydration/KPI.md`; they don't estimate provider cost.

---

## 1. The big picture

```
session_start
 ├─ warmMcpCatalog()            eager: discover the full catalog
 │                              lazy: restore a matching private snapshot first,
 │                                    then refresh live state for the next session
 ├─ …once discovery lands…
 │   └─ writeDiscoveryFile()    .octocode/discovery.json — machine-readable
 │                              inventory: skills + MCP configs + native tools
 └─ startMcpConfigWatcher()     hot-reload mcp.json edits (no restart)

before_agent_start (every turn)
 ├─ await mcpCatalogReady()     bounded wait; never starts a server itself
 ├─ stripPiSkillsSection()      Octocode owns the skill flow (see §3)
 └─ system prompt = Pi prompt
      + static Octocode prompt
      + <mcp_catalog>            eager full-schema rollback path
        OR <mcp_catalog_index>   lazy names/descriptions only, byte-stable
      + <dynamic_capabilities>   self-created tools/skills, usually empty
      + <available_skills>       live skill catalog
      + <active_plan>            compaction-durable plan state
```

Design rule everywhere: **stable bytes**. A lazy snapshot hit freezes the current
session's index while live refresh writes a snapshot for the next session. If discovery
misses the first-turn deadline, its late result doesn't appear in later prompts. Explicit
config and tool-list changes invalidate prepared freshness and leases; validator reuse
remains keyed by the exact schema digest.

---

## 2. MCP: persistent selection index and internal exact schemas

Sources: `packages/octocode-pi-extension/src/tools/mcp-tool.ts`,
`src/tools/mcp-catalog.ts`, and `src/tools/mcp-schema-validator.ts`

### Config sources (loaded in override order)

| Precedence | Scope | Path | Loaded when |
|---|---|---|---|
| 1 | Built-in | Pinned local `octocode-mcp` (`npx` fallback) | Always as `octocode`; can't be removed |
| 2 | Global | `$OCTOCODE_HOME/agent/mcp/servers.json` | When present |
| 3 | Project | `<workspace>/.octocode/agent/mcp/servers.json` | Trusted workspace only |

### Startup and persistence

`warmMcpCatalog()` is deduplicated per workspace:

1. Compute workspace and config digests.
2. Read the versioned snapshot under `$OCTOCODE_HOME/agent/mcp/workspaces/`.
3. On a valid hit, render its schema-free index immediately and freeze those prompt bytes.
4. Discover configured servers in the background, use current schemas only for private
   execution state, and persist the replacement for a later session.

A malformed, unsupported-version, oversized, digest-mismatched, or symlink-escaping
snapshot is a cache miss. Snapshot files are private on POSIX systems. The bounded
`mcpCatalogReady()` wait never starts servers, and a late refresh can't change the
current session's prompt suffix.

### Select, validate, call

```js
MCPTool({queries:[{reasoning:"Search code.", action:"call", server:"octocode",
  tool:"ghSearchCode", arguments:{queries:[/* … */]}}]})
```

`call` discovers the current schema without invoking the remote tool, compiles or reuses
a validator keyed by schema digest, and validates arguments immediately before
`client.callTool`. Invalid arguments return bounded, path-specific
`MCP_SCHEMA_INVALID` errors. Unsupported schemas return `SCHEMA_UNSUPPORTED`; both paths
perform zero remote tool invocations.

`describe` exposes one current exact schema when explicit inspection is useful. Config
drift, list-change signals, restart, and stop invalidate affected discovery freshness;
validator reuse remains keyed by schema digest. Management actions remain live without an
agent restart; adding arbitrary server code requires trust and interactive approval.

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
tool-set timing. Pi's user-facing `/skill:<name>` command remains available.

### The `skill` tool (the Claude Code / agentskills.io pattern)

| Call | Returns |
|---|---|
| `skill({queries:[{reasoning:"load matching skill", type:"load", action:"load", name:"…", reason:"why it matches"}]})` | Full `SKILL.md` (cap 48k, explicit truncation pointer) + skill directory + shipped files, with "resolve relative paths against this directory". Loading requires a concise, user-facing `reason`. Names have a case-insensitive fallback. |
| `skill({queries:[{reasoning:"refresh skill catalog", type:"load", action:"list"}]})` | Every discovered skill with source tag and session usage (`loaded 2× this session`). |

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
come from its frontmatter (directory name fallback). Source files remain owned
by their host. `/settings` stores only normalized global/workspace enablement overrides
in SQLite (`skill_overrides`); workspace overrides win over global overrides,
then the default is enabled.

### Prompt integration

- `<available_skills>` is complete for enabled skills on the initial discovery pass (all enabled names,
  120-character descriptions), then frozen with the rest of the session system
  prompt. It teaches loading via the `skill` tool; `/octocode-skills` and
  `settings.html` exposes the complete enabled/disabled inventory to the user.
  A disabled skill is omitted from the prompt, autocomplete, discovery inventory,
  `/octocode-skills`, and `skill` list/load execution. Changing enablement marks a
  frozen context stale; `/new` rebuilds the prompt while execution blocks immediately.
- The static prompt's `<skills>` section and `<ultimate_reminders>` name
  `skill({queries:[{reasoning:"load matching skill", type:"load", action:"load"…}]})` as THE loading mechanism.

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
  "nativeTools": ["MCPTool", "agent", "askUser", "bash", "file", "…"], // sorted extension-owned palette
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
      { "path": "$OCTOCODE_HOME/agent/mcp.json", "host": "octocode", "scope": "user",
        "format": "json", "active": true,  "servers": [{ "name": "docs", "command": "npx" }] },
      { "path": "~/.claude.json",         "host": "claude", "scope": "user",
        "format": "json", "active": false, "servers": [{ "name": "memory", "command": "memory-mcp" }] },
      { "path": "~/.cursor/mcp.json",     "host": "cursor", "scope": "user",
        "format": "json", "active": false, "servers": [{ "name": "figma" }] },
      { "path": "~/.codex/config.toml",   "host": "codex",  "scope": "user",
        "format": "toml", "active": false, "servers": [{ "name": "node_repl" }] }
    ]
  }
}
```

### MCP config discoverability (`mcp.discoveredConfigs`)

Every existing MCP config file found in these project and user locations:

| Host | Project locations | User locations | Activation |
|---|---|---|---|
| Octocode | `<ws>/.octocode/agent/mcp/servers.json` | `$OCTOCODE_HOME/agent/mcp/servers.json` | Active |
| Claude Code/Desktop | Official `<ws>/.mcp.json`; compatibility `<ws>/.claude/mcp.json` | `~/.claude.json`, `~/.claude/mcp.json`, and Claude Desktop platform config | Discovered, disabled by default |
| Cursor | `<ws>/.cursor/mcp.json` | `~/.cursor/mcp.json` | Discovered, disabled by default |
| Codex | `<ws>/.codex/config.toml` | `~/.codex/config.toml` | Discovered, disabled by default |
| Antigravity / Gemini | `<ws>/.agents/mcp_config.json` | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json` | Discovered, disabled by default |
| Agent compatibility | `<ws>/.agents/mcp.json`, `<ws>/.agent/{mcp,mcp_config}.json` | Matching `~/.agents` and `~/.agent` files | Discovered, disabled by default; a compatibility convention, not part of AGENTS.md |
| VS Code | `<ws>/.vscode/mcp.json` | `~/.vscode/mcp.json` | Discovered, disabled by default |

The global canonical file loads first, followed by the trusted project's canonical file.
The built-in `octocode` server is lower than both file-based entries.

**Security boundary:** foreign definitions are normalized under collision-safe names such as
`cursor.docs`, but every discovered server and tool fails closed until the user explicitly
enables it in `/mcp`. Project imports additionally require workspace trust. Their owning files
remain read-only; canonical Octocode JSON owns managed definitions, SQLite owns only enablement,
and the OS credential store owns OAuth tokens. The machine-readable discovery snapshot emits
only server names and optional commands—never arguments, environment values, headers, or URLs.
Malformed files receive an `error` field instead of aborting discovery.

Host references: [Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Cursor MCP](https://cursor.com/docs/mcp),
[Codex MCP](https://developers.openai.com/codex/mcp/), and
[AGENTS.md](https://agents.md/).

---

## 5. What is in the model's context (measured)

Per-turn Octocode system-prompt addenda stay in stable-to-volatile order:

| # | Block | Model-visible contents | Changes when |
|---|---|---|---|
| 1 | Static Octocode prompt | Harness policy | package release |
| 2a | `<mcp_catalog>` in eager mode | Instructions, descriptions, and every exact schema | next session after explicit catalog invalidation |
| 2b | `<mcp_catalog_index>` in lazy mode | Instructions, names, and descriptions only | session boundary |
| 3 | `<dynamic_capabilities>` | Initial created tool and workflow registries | session boundary |
| 4 | `<available_skills>` | Complete initial skill names and bounded descriptions | session boundary |
| 5 | `<active_plan>` | Initial durable checklist; later progress survives in transcript/tool results and compaction markers | session boundary |

The accepted 12-tool large-schema fixture measures 202,888 eager catalog characters and
752 lazy index characters: a 99.63% reduction. Character count is canonical; it is not a
provider-token or cost claim. A 200-sample local benchmark measured 1.61 ms snapshot-hit
p95 versus 0.007 ms for in-memory index rendering, or 1.60 ms added harness latency.
See the RFC KPI document for commands, environment, and all safety guardrails.

These measurements exclude Pi's base prompt, workspace context, API `tools` definitions,
and conditional prompt blocks. Native support-tool definitions ride in the API `tools`
parameter. Octocode research tools remain behind `MCPTool`; in lazy mode their schemas
are delivered only by preparation results, not the first-turn prompt.

Live view: the footer and `/octocode-status` show prompt-block sizes. `MCPTool` action
`status` also returns the schema mode, snapshot hit/miss counts, preparation count, and
blocked-call count in structured details.

---

## 6. Where things live

| Concern | Source | Tests |
|---|---|---|
| MCP gateway and mode integration | `packages/octocode-pi-extension/src/tools/mcp-tool.ts` | `tests/mcp-tool.test.ts`, `tests/package.test.ts` |
| Persistent catalog snapshot and index | `packages/octocode-pi-extension/src/tools/mcp-catalog.ts` | `tests/mcp-catalog.test.ts` |
| Schema leases and local validation | `packages/octocode-pi-extension/src/tools/mcp-schema-lease.ts`, `src/tools/mcp-schema-validator.ts` | `tests/mcp-schema-validator.test.ts`, `tests/mcp-tool.test.ts` |
| `skill` tool + skill discovery + usage ledger | `packages/octocode-pi-extension/src/tools/skill-tool.ts` | `tests/skill-tool.test.ts` |
| Skill catalog UI (prompt block + dashboard) | `packages/octocode-pi-extension/src/tools/skill-catalog.ts` | `tests/skill-catalog.test.ts` |
| Discovery file + MCP config discoverability | `packages/octocode-pi-extension/src/tools/discovery-file.ts` | `tests/discovery-file.test.ts` |
| Prompt composition + Pi-section strips | `packages/octocode-pi-extension/src/prompt.ts`, `src/prompts/prompt.ts` | `tests/prompt-dedup.test.ts` |
| Session wiring (init discovery, turn-1 await, dashboards) | `packages/octocode-pi-extension/src/index.ts` | `tests/package.test.ts` |

Related package docs: `packages/octocode-pi-extension/docs/TOOLS.md` (tool
reference, MCP section), `docs/UI.md` (TUI surfaces).
