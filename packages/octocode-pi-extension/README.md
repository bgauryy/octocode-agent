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

The build bundles the Octocode workflow skills and invokes the installed Awareness Lite package runtime directly. For manual commands, use the scoped published CLIs:

- Awareness Lite → `npx @octocodeai/octocode-awareness-lite <command> [action] --workspace "$PWD"`
- Management CLI → `npx octocode@latest skill | lsp-server | auth`

## What loads

| Surface | Count |
|---|---:|
| Octocode MCP research tools | 15 |
| Pi support tools | 15 |
| Guarded Pi builtin overrides | 1 (`bash`) |
| Slash command entries | 23 |
| Bundled main-agent skills | 11 |

Awareness Lite is imported **in-process** (no child CLI). The unified Pi surface uses
`plan` for session/shared execution and observed check receipts, `lock` for exceptional
exclusivity, `message` for peer coordination, and `memory` for relevant durable learning.
Only an unread direct-message count is injected automatically; registry membership, advisory
presence, and identifiable mutation lock checks are automatic. `$OCTOCODE_AWARENESS_CLI`
remains the Lite diagnostics/recovery surface. Canonical backend operations and
SQLite data remain available without a parallel Pi tool catalog.

The extension also owns Octocode surface/profile helpers (`buildSurfaceSpec`,
`resolveAwarenessCli`, `loadProfile`, `profileToPiArgs`). `octocode-agent`
imports those helpers directly and only executes the returned specs, so core
policy stays here instead of drifting into launcher shims.

## Quick start

```text
/commands                live guide to every public slash command and when to use it
/octocode                dashboard: status, agents, setup, skills, health
/octocode-now            orientation cockpit: model, context, plan, tasks, agents, git
/octocode-tasks          local plan + shared Awareness task/verification bridge
/octocode-skills         discovered skills and load/install guidance
/octocode-agents         live spawned-worker ledger and controls
/octocode-harness        exact live tools, commands, and skills
/mcp                     open the local MCP connections/tools/configuration manager
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

Routine solo work needs no Awareness start/finish ceremony. Use `plan` when sequencing
helps; select shared scope only for persistent cross-agent execution. Shared Start
projects stable steps onto Awareness tasks, and `plan.complete` records the check you
actually ran before advancing. The harness automatically manages registry membership,
advisory file presence, and peer-lock preflight for identifiable writes.

Act on the bounded `<awareness_signal>` only when it can change the next action. Use an
exclusive `lock` only for sensitive/non-mergeable work and `message` only when peer
coordination is needed. Use `$OCTOCODE_AWARENESS_CLI` for backend diagnostics or
recovery, not as a parallel routine lifecycle.

Never verify another agent’s work or invent a receipt. See
[docs/AWARENESS_AGENT_FLOW.md](docs/AWARENESS_AGENT_FLOW.md) and
[docs/REFLECT.md](docs/REFLECT.md).

## Octocode MCP research tools (15)

These are available through `MCPTool`'s built-in `octocode` server. The gateway
resolves the pinned local `octocode-mcp` package first and falls back to
`npx -y octocode-mcp@latest`, so the extension keeps one MCP/schema surface for research
instead of duplicating tool definitions in the harness:

| Area | Tools |
|---|---|
| GitHub | `ghSearchCode`, `ghSearchRepos`, `ghSearchPullRequests`, `ghSearchIssues`, `ghSearchCommits`, `ghGetFileContent`, `ghViewRepoStructure`, `ghCloneRepo` |
| Local | `localSearchCode`, `localFindFiles`, `localFindDeadCode`, `localGetFileContent`, `localViewStructure` |
| Semantics | `lspGetSemantics` |
| Packages | `npmSearch` |

The branded `octocode-agent` launcher suppresses **all** native Pi built-ins before session
creation in both SDK and subprocess modes. The extension then supplies the full palette,
including its guarded same-name `bash` implementation. For direct Pi extension installs, the
extension defensively disables native `read`, `edit`, `write`, `grep`, `find`, and `ls` on
load and session start. Octocode research replaces reads/search; one `file` tool owns guarded
`edit`, `write`, and `delete` operations. There is no branded-launcher environment opt-out.

**Why, and how to work with overrides:** [docs/OVERRIDES.md](docs/OVERRIDES.md)
(users + developers). UI/status details: [docs/UI.md](docs/UI.md).

## Support tools (15)

| Tool | Purpose |
|---|---|
| `file` | Create, edit, or delete files with path guards, full-batch preflight, atomic writes, stale/lost-update checks, and diffs. |
| `web` | Search provider adapter. |
| `chromeDebug` | Chrome DevTools Protocol operations. |
| `agent` | Spawn typed, browser, or custom workers and inspect, wait, message, steer, abort, or kill them. |
| `callTool` | Reuse, create, or maintain a verified dynamic capability. |
| `skill` | Load/list Agent Skills or run the dynamic skill lifecycle. |
| `plan` | Own session/shared plans, stable task projection, and observed check receipts. |
| `localServer` | Serve inspected/agent-authored static artifacts on loopback. |
| `MCPTool` | MCP v2 gateway for stdio and Streamable HTTP; use `/mcp` for the local management UI. |
| `askUser` | Ask the user a question via an interactive list picker or text input (falls back to inline prose on non-TUI hosts). |
| `memory` | Recall/record/forget durable Awareness memory (first-class wrapper over the memory CLI). |
| `lock` | Acquire, wait for, or release exceptional exclusive file locks. |
| `message` | Send/read cross-agent messages when peer coordination is needed. |
| `readMedia` | Perceive local images, video frames/contact sheets, and audio metadata/waveforms without creating user artifacts. |
| `media` | Author images/PDFs or transform media into GIFs, clips, audio, and converted files. |

The Lite CLI remains available for backend diagnostics and recovery. It does not add
aliases to the Pi tool palette.

`MCPTool` includes one built-in server named `octocode`. Definitions load from
`$OCTOCODE_HOME/agent/mcp/servers.json` and, after workspace trust,
`.octocode/agent/mcp/servers.json`; the project definition wins.

Configured stdio or Streamable HTTP entries can override the built-in default. `MCPTool` query action `list`
returns server instructions plus every tool name, description, and schema summary; query
action `describe` returns the full selected tool schema before query action `call`. The
[external Node MCP integration test](tests/mcp-external.test.ts) proves list and call
operations through the canonical project config. The gateway uses
`@modelcontextprotocol/client` v2 with automatic protocol-version negotiation:

```json
{
  "mcpServers": {
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

## Slash command entries (23)

| Command | Purpose |
|---|---|
| `/commands` | Read the live public command registry, grouped by source, with when-to-use descriptions and GitHub login guidance. |
| `/octocode` | Dashboard: status, agents, setup, skills, health, next actions. |
| `/octocode-now` | Orientation cockpit: model, context, current plan, shared tasks, agents, and git status. |
| `/octocode-tasks` | Bridge local `plan` state with shared Awareness task and verification state. |
| `/octocode-skills` | List Pi-discovered skills and how to load or install them. |
| `/octocode-harness` | Exact registered surface inventory. |
| `/octocode-agents` | Live spawned-worker ledger with inspect, kill, prune, hide, and risk badges. |
| `/octocode-cron` | List, check, or cancel session-scoped Octocode jobs. |
| `/mcp` | Open the configured MCP servers/tools/configuration and enablement manager. |
| `/octocode-setup` | Install/update the managed system-prompt block; `--global` targets user scope. |
| `/octocode-skills-update` | Refresh bundled skill installs. |
| `/octocode-plan` | `new <goal>` enters **plan mode**: the agent researches, proposes a dependency-ordered plan via `plan(propose)`, and write tools are blocked (tool-call gate, `plan mode` status chip) until you Approve (free-text = change request, Reject = stop, `/octocode-plan off` lifts the gate). Also show, start, complete, remove, or clear the active local plan. `html` writes `.octocode/plan.html` + `plan.md` (status checklist, mermaid dependency diagram) and keeps them live-updated on every plan change. The agent-side `plan` tool also supports `action:propose` — set the steps and ask you to Approve/Reject inline (a free-text reply is a change request). |
| `/octocode-theme` | Switch the Octocode theme (`sync`, `dark`, or `light`). |
| `/octocode-chrome` | List or close reused Chrome DevTools Protocol connections. |
| `/octocode-footer` | Footer density: `compact`, `default`, or `full`. The command row contains only `/commands — guide`; metrics and keyboard hints are unchanged. A once-per-session Octocode CLI probe paints `github ✓` green or missing/error states red, and `/commands` provides login guidance without exposing tokens. `legend` prints every segment. |
| `/octocode-permissions` | Session approval controls: show the permission level and always-allowed action classes, `level strict|default|relaxed`, or `revoke all|<class>`. Cycle the level from the keyboard (default `ctrl+shift+a`, override `OCTOCODE_PERMISSIONS_KEY`); pin a session's starting level with `OCTOCODE_PERMISSION_LEVEL`. The footer always shows the live mode (`perm <level> +N`). All state is session-scoped and resets on a new session. |
| `/octocode-profile` | Apply a named profile from `~/.octocode/profiles.json` to the live Pi session: model, active tool include/exclude scope, and the closest approval mode (`always` → relaxed, `never` → strict, `ask` → default). |
| `/octocode-inbox` | Worker inbox overlay: pick a spawned agent, then view its transcript, steer it, or kill it. Completions/failures also fire desktop (OSC 9) notifications. |
| `/octocode-palette` | Command palette over every slash command plus direct actions; default shortcut `ctrl+shift+k` (override with `OCTOCODE_PALETTE_KEY`). |
| `/octocode-rewind` | List and restore automatic shadow-git file checkpoints taken before each user prompt; optionally rewinds the conversation too. |
| `/octocode-dial` | One-knob effort dial (`low`/`medium`/`high`/`ultra`): thinking level + worker parallelism. |
| `/octocode-watch` | Aider-style watch mode: comments ending in `AI!` saved from any editor become agent prompts (`on\|off\|status`, auto-start with `OCTOCODE_WATCH=1`). |
| `/octocode-export` | Brand a pi `/export` session HTML file with Octocode styling (idempotent). |
Backend handoffs, task repair, verification audits, and presence diagnostics stay on
`$OCTOCODE_AWARENESS_CLI`; they are not a second routine Pi lifecycle. Session jobs are
report-first wrappers over that CLI; see [docs/CRON.md](docs/CRON.md).

## Bundled skills (11)

Pi discovers the npm-published, build-generated skill tree under `dist/skills/`,
surfaced at runtime through the single `resources_discover` hook (no package-root
`skills/` dir and no `pi.skills` entry, which would double-surface and trigger a
`[Skill conflicts]` notice). The build bundles the coding-agent Octocode skill set so every
supported workflow is discoverable on init with zero setup:

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

The workflow skills are copied from the `octocode` dependency’s `skills/` tree at
build time. Awareness Lite remains an installed in-process runtime and recovery CLI,
not a bundled skill. The Pi build owns generated skill copies; never edit them by hand.
Installing the same skill globally (`npx octocode@latest skill --name <skill>
--platform pi`) is redundant now and will surface a `[Skill conflicts]` notice.

## Awareness Lite bridge

The bridge exposes `$OCTOCODE_SKILL_ROOT` for the bundled Lite skill and keeps
`$OCTOCODE_AWARENESS_CLI` as an informational compatibility string pointing at the installed package CLI. Runtime calls use that local dependency path rather than `npx` package resolution. Identity is explicit: pass `--agent-id` to commands that mutate tasks, locks, work, handoffs, or verification state.

The bridge joins/leaves the agent registry automatically. After all identifiable targets
pass peer-lock preflight, structured writes and detected bash targets refresh advisory
presence; presence failure warns and fails open. A peer lock blocks before any target
executes. Missing stores fail open, while query failure against an existing store fails
closed for identifiable mutations. Opaque interpreter writes and implicit build outputs
remain documented non-blocking coverage limits. Ordinary advisory overlap stays allowed.

## System prompt

The consolidated source lives in `src/prompts/prompt.ts` and builds to
`dist/system/SYSTEM_PROMPT.md`. It defines authority, operating mode, Awareness,
tool routing, research evidence, skills, code discipline, and safety. Managed
prompt installation is marker-based and idempotent.

## Configuration

The extension loads Octocode configuration through `@octocodeai/config`.

| Variable | Purpose |
|---|---|
| `OCTOCODE_AGENT_ID` | Optional explicit stable identity for Awareness Lite commands. |
| `OCTOCODE_AWARENESS_CLI` | Bundled Lite diagnostics/recovery CLI path. |
| `GITHUB_TOKEN`, `GH_TOKEN`, `OCTOCODE_TOKEN` | GitHub authentication. |
| `ENABLE_LOCAL` | Enable local research tools (default on). |
| `ENABLE_CLONE` | Enable `ghCloneRepo`. |
| `TAVILY_API_KEY`, `SERPER_API_KEY` | Higher-quality web providers. |
| `OCTOCODE_NO_VERIFY_GATE=1` | Emergency bypass for a misfiring finish gate. |

Never put secrets into prompts, logs, Awareness memory, or committed config.

## Troubleshooting

| Symptom | Action |
|---|---|
| Extension appears inactive | Run `/octocode`, then `/octocode-harness`; use `/commands` for the full command guide. |
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
