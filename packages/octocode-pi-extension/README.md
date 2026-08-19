# @octocodeai/pi-extension

<div align="center">
<img src="../../../packages/assets/extension.png" width="640px" alt="Octocode + Pi">
</div>

Octocode’s research tools, Awareness Lite coordination, system prompt, skills,
web providers, and subagents as one Pi extension.

```bash
pi install npm:@octocodeai/pi-extension
/octocode
```

The build bundles the Awareness Lite runtime CLI and uses the published Octocode CLI through `npx` for management commands:

- `$OCTOCODE_AWARENESS_CLI` → `node "$OCTOCODE_AWARENESS_CLI" <command> [action] --workspace "$PWD"`
- Management CLI → `npx octocode@latest skill | lsp-server | auth`

## What loads

| Surface | Count |
|---|---:|
| Octocode MCP research tools | 13 |
| Pi support tools | 11 |
| Replacement edit + write + bash tools | 3 |
| Slash commands | 11 |
| Bundled main-agent skills | 1 |

Awareness Lite memory and coordination are deliberately not Pi tools. Agents use
the bundled CLI under the `octocode-awareness-lite` skill for explicit `status`,
`plan`, `task`, `lock`, `work`, `handoff`, `check`, and `memory` commands. This
keeps one CLI/schema contract instead of duplicating it in Pi tool definitions.

## Quick start

```text
/octocode                dashboard: status, agents, setup, skills, health
/octocode-now            orientation cockpit: model, context, plan, tasks, agents, git
/octocode-tasks          local plan + shared Awareness task/verification bridge
/octocode-skills         discovered skills and load/install guidance
/octocode-agents         live spawned-worker ledger and controls
/octocode-status         health and configured surfaces
/octocode-harness        exact live tools, commands, and skills
/octocode-mcp            inspect/manage .pi/agent/mcp.json servers
/octocode-cron           list/check/cancel session-scoped Octocode jobs
/octocode-setup          manage project .pi/APPEND_SYSTEM.md
/octocode-skills-update  refresh bundled skill installs
/octocode-inbox          worker inbox: view transcript, steer, or kill spawned agents
/octocode-palette        command palette (default shortcut ctrl+o)
/octocode-rewind         restore files from an automatic pre-prompt checkpoint
/octocode-dial           effort dial: thinking level + worker parallelism in one knob
/octocode-watch          watch mode: `// … AI!` comments in your editor become prompts
/octocode-export         brand a pi session HTML export with Octocode styling
```

At the start of coding work, the agent can inspect the Lite coordination store:

```bash
node "$OCTOCODE_AWARENESS_CLI" status --workspace "$PWD"
```

It then claims a Lite task or opens standalone advisory Work:

```bash
node "$OCTOCODE_AWARENESS_CLI" task claim \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID"
node "$OCTOCODE_AWARENESS_CLI" work start \
  --workspace "$PWD" --file src/a.ts --agent-id "$OCTOCODE_AGENT_ID" \
  --reason "fix parser"
```

Ordinary file presence is advisory and can overlap. Use `lock acquire` for
sensitive/non-mergeable work. Finish the exact owned task after its stated check:

```bash
node "$OCTOCODE_AWARENESS_CLI" task done \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID"
node "$OCTOCODE_AWARENESS_CLI" verify mark \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID" \
  --message "parser tests passed"
```

Do not batch-verify another agent’s work. See
[docs/AWARENESS_AGENT_FLOW.md](docs/AWARENESS_AGENT_FLOW.md) and
[docs/REFLECT.md](docs/REFLECT.md).

## Octocode MCP research tools (13)

These are available through `MCPTool`'s built-in lazy `octocode` server
(`npx -y octocode-mcp@latest`), so the extension keeps one MCP/schema surface for
research instead of duplicating tool definitions in the harness:

| Area | Tools |
|---|---|
| GitHub | `ghSearchCode`, `ghSearchRepos`, `ghHistoryResearch`, `ghGetFileContent`, `ghViewRepoStructure`, `ghCloneRepo` |
| Local | `localSearchCode`, `localFindFiles`, `localGetFileContent`, `localViewStructure`, `localBinaryInspect` |
| Semantics | `lspGetSemantics` |
| Packages | `npmSearch` |

Pi’s built-in `read`, `grep`, `find`, and `ls` are disabled in favor of the
corresponding Octocode tools. The extension replaces Pi’s `edit`, `write`, and
`bash` tools: `edit` is batch-aware with stale-read checks and Myers diffs
(native engine when available); `write`/`bash` add Octocode path-guard on
mutation targets.

**Why, and how to work with overrides:** [docs/OVERRIDES.md](docs/OVERRIDES.md)
(users + developers). UI/status details: [docs/UI.md](docs/UI.md).

## Support tools (11)

| Tool | Purpose |
|---|---|
| `web` | Search provider adapter. |
| `chromeDebug` | Chrome DevTools Protocol operations. |
| `browserAgent` | Multi-turn browser subagent. |
| `spawnSubagent` | Spawn a declared packaged subagent. |
| `MCPTool` | Dedicated SDK-backed stdio MCP bridge using `.pi/agent/mcp.json` or `~/.pi/agent/mcp.json`. |
| `mcp` | Compatibility alias for `MCPTool`. |
| `askUser` | Ask the user a question via an interactive list picker or text input (falls back to inline prose on non-TUI hosts). |
| `memory` | Recall/record/forget durable Awareness memory (first-class wrapper over the memory CLI). |
| `manage_context` | Inspect and compact Pi context. |
| `spawnAgent` | Start a background Pi worker. |
| `AgentMessage` | List, message, steer, wait for, abort, or kill workers. |

Awareness Lite commands such as `status`, `plan list`, `task list`, `work start`,
`handoff list`, `memory recall`, and `verify audit` are invoked through
`$OCTOCODE_AWARENESS_CLI`, not registered again as tools.

`MCPTool` includes one built-in lazy server named `octocode` that runs
`npx -y octocode-mcp@latest` when used. Project config loads only after Pi
trusts the project; global config always loads from `~/.pi/agent/mcp.json`.
Configured entries can override the built-in default. `MCPTool action:list`
returns server instructions plus every tool name, description, and schema
summary; `action:describe` returns the full selected tool schema before
`action:call`. Supported servers are stdio command servers via
`@modelcontextprotocol/sdk`:

```json
{
  "mcpServers": {
    "octocode": {
      "command": "npx",
      "args": ["-y", "octocode-mcp@latest"]
    },
    "example": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": {},
      "cwd": ".",
      "timeoutMs": 30000
    }
  }
}
```

## Slash commands (17)

| Command | Purpose |
|---|---|
| `/octocode` | Dashboard: status, agents, setup, skills, health, next actions. |
| `/octocode-now` | Orientation cockpit: model, context, current plan, shared tasks, agents, and git status. |
| `/octocode-tasks` | Bridge local `plan` state with shared Awareness task and verification state. |
| `/octocode-skills` | List Pi-discovered skills and how to load or install them. |
| `/octocode-status` | Health, prompt, skills, Awareness runtime, and providers. |
| `/octocode-harness` | Exact registered surface inventory. |
| `/octocode-agents` | Live spawned-worker ledger with inspect, kill, prune, hide, and risk badges. |
| `/octocode-cron` / `/cron` | List, check, or cancel session-scoped Octocode jobs. |
| `/octocode-mcp` / `/mcp` | Inspect/manage configured stdio MCP servers. |
| `/octocode-setup` | Install/update the managed system-prompt block; `--global` targets user scope. |
| `/octocode-skills-update` | Refresh bundled skill installs. |
| `/octocode-inbox` | Worker inbox overlay: pick a spawned agent, then view its transcript, steer it, or kill it. Completions/failures also fire desktop (OSC 9) notifications. |
| `/octocode-palette` | Command palette over every slash command plus direct actions; default shortcut `ctrl+o` (override with `OCTOCODE_PALETTE_KEY`). |
| `/octocode-rewind` | List and restore automatic shadow-git file checkpoints taken before each user prompt; optionally rewinds the conversation too. |
| `/octocode-dial` | One-knob effort dial (`low`/`medium`/`high`/`ultra`): thinking level + worker parallelism, optional per-level model override via `OCTOCODE_DIAL_<LEVEL>_MODEL`. |
| `/octocode-watch` | Aider-style watch mode: comments ending in `AI!` saved from any editor become agent prompts (`on\|off\|status`, auto-start with `OCTOCODE_WATCH=1`). |
| `/octocode-export` | Brand a pi `/export` session HTML file with Octocode styling (idempotent). |
Memory recall/recording, handoffs, tasks, verification, locks, and work presence
all stay on the bundled Awareness Lite CLI. Session jobs are report-first wrappers
over that CLI; see [docs/CRON.md](docs/CRON.md). The extension does not maintain a
parallel memory adapter or slash-command schema.

## Bundled skill (1)

Pi discovers the npm-published, build-generated skill tree under `dist/skills/`.
The extension bundles only `octocode-awareness-lite` there so Pi has one package-owned
coordination skill and avoids duplicate package-root skill discovery conflicts.

- `octocode-awareness-lite`

`octocode-awareness-lite` is copied from the Awareness Lite package’s canonical skill. Other
workflow skills (`octocode-research`, `octocode-roast`, `octocode-subagent`, and
friends) are installed on demand with `npx octocode@latest skill --name <skill>
--platform pi`. The Pi build owns the generated copy; never edit it by hand.

## Awareness Lite bridge

The bridge exposes `$OCTOCODE_AWARENESS_CLI` and `$OCTOCODE_SKILL_ROOT` for the
bundled Lite CLI and skill. Identity is explicit: pass `--agent-id` to commands
that mutate tasks, locks, work, handoffs, or verification state.

Awareness Lite does not wire full Pi lifecycle hooks. It wires only a pre-edit
lock-conflict gate for write/edit tools, so an active Lite `lock` held by another
agent blocks the edit. Agents still coordinate by running `task`, `work`, `lock`,
`handoff`, and `verify` commands directly; ordinary advisory overlap stays
visible and allowed through the Lite SQLite store.

## System prompt

Authored sections live under `src/prompts/sections/` and build to
`dist/system/SYSTEM_PROMPT.md`. They define authority, operating mode, Awareness,
tool routing, research evidence, skills, code discipline, and safety. Managed
prompt installation is marker-based and idempotent.

## Configuration

The extension loads Octocode configuration through `@octocodeai/config`.

| Variable | Purpose |
|---|---|
| `OCTOCODE_AGENT_ID` | Optional explicit stable identity for Awareness Lite commands. |
| `OCTOCODE_AWARENESS_CLI` | Bundled Awareness Lite CLI path set by the harness. |
| `GITHUB_TOKEN`, `GH_TOKEN`, `OCTOCODE_TOKEN` | GitHub authentication. |
| `ENABLE_LOCAL` | Enable local research tools (default on). |
| `ENABLE_CLONE` | Enable `ghCloneRepo`. |
| `TAVILY_API_KEY`, `SERPER_API_KEY` | Higher-quality web providers. |
| `OCTOCODE_NO_VERIFY_GATE=1` | Emergency bypass for a misfiring finish gate. |

Never put secrets into prompts, logs, Awareness memory, or committed config.

## Troubleshooting

| Symptom | Action |
|---|---|
| Extension appears inactive | Run `/octocode-status`, then `/octocode-harness`. |
| Awareness Lite command missing | Check `$OCTOCODE_AWARENESS_CLI` exists and run `node "$OCTOCODE_AWARENESS_CLI" schema`. |
| Verification debt remains | Run the stated test, `verify audit --workspace "$PWD"`, then `verify mark --task-id <task-id> --agent-id <agent-id> --message <evidence>`. |
| Stale work presence | Audit exact ownership and explicitly run `work end` or `lock release` only after review. |
| Compaction says “Nothing to compact” | Benign: the session is too small to summarize, so the extension reports it as skipped. |
| Internal/model/tool errors need debugging | Check repo-local `.octocode/logs/error.txt`. Entries include timestamp, uptime, cwd, mode, model/context usage when available, duration, details, stack/cause, and redacted secrets. |
| “Model stopped because it reached the maximum output token limit” | The answer was too large for one model response. Compaction does not increase that output budget; ask for a concise/chunked continuation or write long output to a file and return a path plus summary. |
| Local research tools absent | Check `ENABLE_LOCAL`. |
| Clone tool absent | Set `ENABLE_CLONE=1`. |

## Development

```bash
yarn workspace @octocodeai/pi-extension typecheck
yarn workspace @octocodeai/pi-extension test
yarn workspace @octocodeai/pi-extension check:no-workspace
```

The last gate must pass before packaging; it verifies that published dependencies
are semver-pinned and no `workspace:`/`file:` protocol leaks into the package.
