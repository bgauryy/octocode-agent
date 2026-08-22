# @octocodeai/pi-extension

<div align="center">
<img src="../../../packages/assets/extension.png" width="640px" alt="Octocode + Pi">
</div>

Octocode’s research tools, Awareness Lite coordination, system prompt, skills,
web providers, subagents, and launcher-consumed surface/profile specs as one Pi extension.
It is the evidence-first, team-ready Pi harness profile: heavier than a single-purpose package,
but built for repo-scale research, guarded edits, workers, MCP/browser/web, and verification.

For the quick product comparison, see [docs/WHY_OCTOCODE.md](docs/WHY_OCTOCODE.md).

Package resource note: `package.json` intentionally exposes only the extension entrypoint and themes. Bundled skills, prompt fragments, context resources, and discovery files are returned from the extension's `resources_discover` hook so the runtime can inject generated paths, avoid duplicate Pi resource registration, and keep worker/resource-mode behavior under one owner.

Most users should install the branded agent wrapper instead:

```bash
npm install -g octocode-agent
octocode-agent
```

Install this package directly only if you already use Pi and want the Octocode harness inside that Pi install:

```bash
pi install npm:@octocodeai/pi-extension
/octocode
```

Direct Pi installation loads the same core harness, but it does not provide the `octocode-agent` launcher UX (`update`, `doctor`, `auth`, `models`, cross-project `resume`, branded launch defaults, and the one-command update path).

The build bundles the Awareness Lite skill and invokes its installed scoped package runtime directly. For manual commands, use the scoped published CLIs:

- Awareness Lite → `npx @octocodeai/octocode-awareness-lite <command> [action] --workspace "$PWD"`
- Management CLI → `npx octocode@latest skill | lsp-server | auth`

## What loads

| Surface | Count |
|---|---:|
| Octocode MCP research tools | 13 |
| Pi support tools | 17 |
| Replacement edit + write + bash tools | 3 |
| Slash command entries | 25 |
| Bundled main-agent skills | 13 |

Awareness Lite coordination stays on the CLI. Agents use
`npx @octocodeai/octocode-awareness-lite` under the `octocode-awareness-lite` skill for explicit `status`,
`plan`, `task`, `lock`, `work`, `handoff`, and `check` commands. The only
model-callable Awareness wrapper is `memory`, which shells the same Lite memory
CLI for `recall`, `record`, and `forget` so agents can use durable lessons without
duplicating the coordination schema as Pi tools.

The extension also owns Octocode surface/profile helpers (`buildSurfaceSpec`,
`resolveAwarenessCli`, `loadProfile`, `profileToPiArgs`). `octocode-agent`
imports those helpers directly and only executes the returned specs, so core
policy stays here instead of drifting into launcher shims.

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
/octocode-plan           plan mode (new <goal>) · manage the active plan (html opens a live visual page)
/octocode-theme          switch Octocode theme: sync, dark, or light
/octocode-chrome         list or close reused Chrome DevTools connections
/octocode-footer         footer density: compact, default, or full
/octocode-permissions    session approval controls: level + always-allowed classes
/octocode-profile        apply a named ~/.octocode/profiles.json profile live
/octocode-inbox          worker inbox: view transcript, steer, or kill spawned agents
/octocode-palette        command palette (default shortcut ctrl+shift+k)
/octocode-rewind         restore files from an automatic pre-prompt checkpoint
/octocode-dial           effort dial: thinking level + worker parallelism in one knob
/octocode-watch          watch mode: `// … AI!` comments in your editor become prompts
/octocode-export         brand a pi session HTML export with Octocode styling
```

At the start of coding work, the agent can inspect the Lite coordination store:

```bash
npx @octocodeai/octocode-awareness-lite status --workspace "$PWD"
```

It then claims a Lite task or opens standalone advisory Work:

```bash
npx @octocodeai/octocode-awareness-lite task claim \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID"
npx @octocodeai/octocode-awareness-lite work start \
  --workspace "$PWD" --file src/a.ts --agent-id "$OCTOCODE_AGENT_ID" \
  --reason "fix parser"
```

Ordinary file presence is advisory and can overlap. Use `lock acquire` for
sensitive/non-mergeable work. Finish the exact owned task after its stated check:

```bash
npx @octocodeai/octocode-awareness-lite task done \
  --workspace "$PWD" --task-id task_123 --agent-id "$OCTOCODE_AGENT_ID"
npx @octocodeai/octocode-awareness-lite check mark \
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
`bash` tools: all three require a non-empty `reasoning` field so users can see why
the mutation or command is happening; `edit` is batch-aware with stale-read checks
and Myers diffs (native engine when available); `write`/`bash` add Octocode
path-guard on mutation targets.

**Why, and how to work with overrides:** [docs/OVERRIDES.md](docs/OVERRIDES.md)
(users + developers). UI/status details: [docs/UI.md](docs/UI.md).

## Support tools (17)

| Tool | Purpose |
|---|---|
| `web` | Search provider adapter. |
| `chromeDebug` | Chrome DevTools Protocol operations. |
| `browserAgent` | Multi-turn browser subagent. |
| `spawnSubagent` | Spawn a declared packaged subagent. |
| `MCPTool` | Dedicated SDK-backed stdio MCP bridge using `.pi/agent/mcp.json` or `~/.pi/agent/mcp.json`. `/mcp` is a slash-command alias for the MCP status/management UI, not a model-callable tool alias. |
| `askUser` | Ask the user a question via an interactive list picker or text input (falls back to inline prose on non-TUI hosts). |
| `memory` | Recall/record/forget durable Awareness memory (first-class wrapper over the memory CLI). |
| `manage_context` | Inspect and compact Pi context. |
| `spawnAgent` | Start a background Pi worker. |
| `AgentMessage` | List, message, steer, wait for, abort, or kill workers. |
| `callTool` | Reuse, create, or maintain a verified dynamic capability. |
| `callSkill` | Reuse, create, or maintain a reusable multi-step workflow skill. |
| `skill` | Load or list Agent Skills discovered by Pi. |
| `plan` | Track or propose the live task checklist. |
| `localServer` | Serve inspected/agent-authored static artifacts on loopback. |
| `readImage` | Load a local image (png/jpeg/gif/webp ≤ 4MB) so a vision model can see it; rendered inline in image-capable terminals. |
| `createImage` | Render agent-authored `svg` (via resvg) or `html` (via headless Chrome) to a PNG shown inline; saves + offers to open in a browser on terminals without image support. |

Awareness Lite coordination commands such as `status`, `plan list`, `task list`,
`work start`, `handoff list`, and `check audit` are invoked through
`npx @octocodeai/octocode-awareness-lite`, not registered again as tools. Memory is
exposed both through that CLI and the small `memory` wrapper tool above.

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

## Slash command entries (25)

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
| `/octocode-plan` | `new <goal>` enters **plan mode**: the agent researches, proposes a dependency-ordered plan via `plan(propose)`, and write tools are blocked (tool-call gate, `plan mode` status chip) until you Approve (free-text = change request, Reject = stop, `/octocode-plan off` lifts the gate). Also show, start, complete, remove, or clear the active local plan. `html` writes `.octocode/plan.html` + `plan.md` (status checklist, mermaid dependency diagram) and keeps them live-updated on every plan change. The agent-side `plan` tool also supports `action:propose` — set the steps and ask you to Approve/Reject inline (a free-text reply is a change request). |
| `/octocode-theme` | Switch the Octocode theme (`sync`, `dark`, or `light`). |
| `/octocode-chrome` | List or close reused Chrome DevTools Protocol connections. |
| `/octocode-footer` | Footer density: `compact` (context/workers/attention flags/git only), `default` (no session timer), `full` (everything). `legend` prints the meaning of every toolbar segment. |
| `/octocode-permissions` | Session approval controls: show the permission level and always-allowed action classes, `level strict|default|relaxed`, or `revoke all|<class>`. Cycle the level from the keyboard (default `ctrl+shift+a`, override `OCTOCODE_PERMISSIONS_KEY`); pin a session's starting level with `OCTOCODE_PERMISSION_LEVEL`. The footer always shows the live mode (`perm <level> +N`). All state is session-scoped and resets on a new session. |
| `/octocode-profile` | Apply a named profile from `~/.octocode/profiles.json` to the live Pi session: model, active tool include/exclude scope, and the closest approval mode (`always` → relaxed, `never` → strict, `ask` → default). |
| `/octocode-inbox` | Worker inbox overlay: pick a spawned agent, then view its transcript, steer it, or kill it. Completions/failures also fire desktop (OSC 9) notifications. |
| `/octocode-palette` | Command palette over every slash command plus direct actions; default shortcut `ctrl+shift+k` (override with `OCTOCODE_PALETTE_KEY`). |
| `/octocode-rewind` | List and restore automatic shadow-git file checkpoints taken before each user prompt; optionally rewinds the conversation too. |
| `/octocode-dial` | One-knob effort dial (`low`/`medium`/`high`/`ultra`): thinking level + worker parallelism, optional per-level model override via `OCTOCODE_DIAL_<LEVEL>_MODEL`. |
| `/octocode-watch` | Aider-style watch mode: comments ending in `AI!` saved from any editor become agent prompts (`on\|off\|status`, auto-start with `OCTOCODE_WATCH=1`). |
| `/octocode-export` | Brand a pi `/export` session HTML file with Octocode styling (idempotent). |
Memory recall/recording, handoffs, tasks, verification, locks, and work presence
all stay on `npx @octocodeai/octocode-awareness-lite`. Session jobs are report-first wrappers
over that CLI; see [docs/CRON.md](docs/CRON.md). The extension does not maintain a
parallel memory adapter or slash-command schema.

## Bundled skills (13)

Pi discovers the npm-published, build-generated skill tree under `dist/skills/`,
surfaced at runtime through the single `resources_discover` hook (no package-root
`skills/` dir and no `pi.skills` entry, which would double-surface and trigger a
`[Skill conflicts]` notice). The build bundles the coding-agent Octocode skill set so every
supported workflow is discoverable on init with zero setup:

- `octocode-awareness-lite`
- `octocode-brainstorming`
- `octocode-chrome-devtools`
- `octocode-documentation`
- `octocode-graph-eval`
- `octocode-prompt-optimizer`
- `octocode-research`
- `octocode-rfc-generator`
- `octocode-roast`
- `octocode-scraping`
- `octocode-skills`
- `octocode-subagent`

`octocode-awareness-lite` is copied from the Awareness Lite package’s canonical skill;
the remaining workflow skills are copied from the `octocode` dependency’s `skills/`
tree at build time. The Pi build owns the generated copies; never edit them by hand.
Installing the same skill globally (`npx octocode@latest skill --name <skill>
--platform pi`) is redundant now and will surface a `[Skill conflicts]` notice.

## Awareness Lite bridge

The bridge exposes `$OCTOCODE_SKILL_ROOT` for the bundled Lite skill and keeps
`$OCTOCODE_AWARENESS_CLI` as an informational compatibility string pointing at the installed package CLI. Runtime calls use that local dependency path rather than `npx` package resolution. Identity is explicit: pass `--agent-id` to commands that mutate tasks, locks, work, handoffs, or verification state.

Awareness Lite does not wire full Pi lifecycle hooks. It wires only a pre-edit
lock-conflict gate for write/edit tools, so an active Lite `lock` held by another
agent blocks the edit. Agents still coordinate by running `task`, `work`, `lock`,
`handoff`, and `check` commands directly; ordinary advisory overlap stays
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
| `OCTOCODE_AWARENESS_CLI` | Informational compatibility string: installed `@octocodeai/octocode-awareness-lite` CLI path. |
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
| Awareness Lite command missing | Run `npx @octocodeai/octocode-awareness-lite schema`; if npx cannot resolve it, reinstall/update dependencies. |
| Verification debt remains | Run the stated test, `npx @octocodeai/octocode-awareness-lite check audit --workspace "$PWD"`, then `npx @octocodeai/octocode-awareness-lite check mark --task-id <task-id> --agent-id <agent-id> --message <evidence>`. |
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
