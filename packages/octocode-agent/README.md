# octocode-agent

The native Octocode coding agent: one command, one update path, and no native Pi dependency.

Run it without installing it globally:

```bash
npx octocode-agent
```

The launcher opens the interactive terminal by default and enables the Node.js
FFI support required by OpenTUI automatically. Users don't need to set
`NODE_OPTIONS`.

To install the command globally and initialize managed configuration, run:

```bash
npm install -g octocode-agent
octocode-agent setup --fix
octocode-agent
```

The native launcher composes `@octocodeai/agent-core` with:

- OpenAI-compatible model streaming and tool calls;
- the live `octocode` catalog and exact tool schemas;
- the packaged Rust SQLite actor for durable sessions, effect settlement,
  automations, and worker-message leases, plus a separate filesystem service;
- native `file`, `bash`, `web`, and `runFfmpeg` base tools with
  input-sensitive policy;
- revisioned settings and a session-owned automation scheduler;
- interactive OpenTUI plus print, JSON, and versioned RPC transports;
- host-neutral lifecycle, policy, hooks, plugin, model, and settings contracts.

The interactive composition uses a renderer-neutral boundary:

```text
versioned RuntimeEvent -> interactive-controller subscription
                       -> native runtime projector -> NativePresentationEvent
                       -> NativeInteractivePresentationPort.accept
                       -> OpenTUI reducer/store -> widgets and renderer
OpenTUI input -> native interactive controller -> core commands
```

See [the native architecture guide](ARCHITECTURE.md) for the complete module map
and event, controller, presentation, persistence, and transport flows.

Programmatic native extensions can register executable custom tools through the
activation writer's `addTool` API. Each tool is namespaced to its plugin, requires
an exact reviewed hash plus `tools.register`, declares effects/policy, and holds an
activation lease while executing. Filesystem plugin manifests cannot embed code,
so declarative JSON `tools` contributions fail closed instead of appearing ready
but inert.

`@octocodeai/pi-extension` remains a separately supported adapter for existing Pi users. It is not a dependency of the native launcher.

## Commands

```text
octocode-agent [--] [prompt]     Interactive native terminal (`--` forces prompt parsing)
octocode-agent run <prompt>      One-shot text output
printf 'prompt\n' | octocode-agent run
octocode-agent run --json ...    One-shot JSON events
octocode-agent run --permissions strict|default|allow-all ...
octocode-agent serve             Versioned JSONL RPC on stdio

octocode-agent config get <key>
octocode-agent config set <key> <value>
octocode-agent config list
octocode-agent config sources
octocode-agent setup [--fix] [--scope global|project|all]
octocode-agent auth [login]
octocode-agent models [--set provider/model|--check] [--json]
octocode-agent discover [models|mcp|skills] [--json]
octocode-agent sessions
octocode-agent resume [session]
octocode-agent session [args]
octocode-agent doctor
octocode-agent update [platform]
octocode-agent completion bash|zsh|fish
octocode-agent tools|skills
octocode-agent help [command]
```

Run `octocode-agent --help` for every top-level flag, or run
`octocode-agent help <command>` for command-specific usage.
See the [headless runtime guide](docs/HEADLESS.md) for prompt composition,
protocol envelopes, caching, MCP, and Agent Skills behavior.
See [parallel tools, MCP calls, and workers](docs/PARALLELISM_AND_WORKERS.md)
for concurrency limits, root-only `--allow-workers`, leaf children, and join behavior.
See [permissions and context](docs/PERMISSIONS_AND_CONTEXT.md) for HITL modes,
capability ceilings, context artifacts, cache-stable assembly, memory, and compaction.

Interactive slash commands include `/help`, `/status`, `/tools`, `/skills`,
`/thinking`, `/steer`, `/clear`, `/compact`, `/plan show`, and
`/automations list|run|cancel`, and `/settings [section]`.
`/settings` opens the secure loopback configuration center; see the
[settings guide](docs/SETTINGS.md) for its current capabilities and limits.
`/clear` starts a fresh session with empty model context and zero session token
usage. The previous durable session remains available to resume, and its visible
transcript stays on screen for continuity.
`/compact` uses the launcher's durable compaction service. Manual and automatic
compaction commit the validated summary projection before replacing live context.

## Interactive terminal behavior

The terminal keeps the conversation primary and projects operational state into
bounded, readable surfaces:

- The header shows the active mode, trust state, selected model, and session state.
- The conversation surface distinguishes user messages, assistant messages,
  failures, cancellations, safe thinking phases, tools, MCP calls, and Skills.
  Dedicated surfaces show plans, approvals, compaction, and workers.
- The Activity/Context rail shows detailed status and token usage on wide terminals.
  Narrow terminals retain a prioritized one-line summary instead of discarding the
  state.
- The footer shows only the most relevant active lifecycle state and keyboard help.
  Session changes, provider requests, resource discovery, trust resolution, and
  compaction update it as events arrive.
- Context details include input, output, cache-read, and cache-write token counts
  when the provider reports them. The compact footer reports occupied context and
  the percentage remaining.
- Base tools use human-readable summaries such as the file path, command, URL, or
  media target. Raw tool arguments and runtime payloads don't become transcript
  content.
- Session switching replaces the visible transcript with the selected session.
  Resume after compaction restores committed visible history separately from the
  retained model context.

The terminal shows safe phases such as `Thinking…` and `Planning…`. It never shows
hidden chain-of-thought, provider reasoning payloads, credentials, or private worker
prompts. See the [terminal design system](docs/TERMINAL_DESIGN_SYSTEM.md) for the
semantic and accessibility contract.

Use `--model provider/model` on an interactive, `run`, or `serve` invocation to
override the configured model for that process. Add one or more
`--fallback-model provider/model` flags to opt into an ordered preflight chain.
The launcher probes the primary first, selects the first provider that passes,
and fails closed if none pass. It never changes providers implicitly. Run
`octocode-agent models --check` (or add `--json`) to verify the configured default;
the report contains only sanitized readiness and failure categories, never secrets
or provider response bodies.

## Storage ownership

The native Agent owns only `$OCTOCODE_HOME/agent/`:

| Path | Owner and purpose |
|---|---|
| `$OCTOCODE_HOME/agent/agent.sqlite3` | Agent control, settings, discovery, and session indexes |
| `$OCTOCODE_HOME/agent/core.sqlite3` | Rust-backed sessions, events, effects, lifecycle records, automations, worker communication, dependency-work ledgers, leases, revisions, and fencing |
| `$OCTOCODE_HOME/agent/sessions/` | Agent session artifacts; the file fallback uses encoded `.json`, `.bak`, `.head`, and `.segments/` records, while Rust-backed sessions remain canonical in `core.sqlite3` |
| `$OCTOCODE_HOME/agent/workspaces/` | Workspace-keyed Agent configuration and discovery artifacts |

Other CLI/MCP databases under `.octocode/` remain with their own owners.

## Runtime configuration

Configuration uses the following precedence, from highest to lowest:

1. Session flags such as `--model` and `--permissions`.
2. Native settings stored under `$OCTOCODE_HOME/agent/`.
3. A trusted workspace Pi selection, then the Pi user selection, when native
   settings don't select a model.
4. The canonical OpenAI default.

Session flags don't rewrite persistent settings. Use
`octocode-agent models --set <provider/model>` to save provider and model
atomically. Use `octocode-agent config get|set|list` for the other public
settings. See the [settings reference](docs/SETTINGS.md) for keys, accepted
values, defaults, and application timing.

Model/provider discovery is file-backed. Environment variables supply credentials only:

```text
OCTOCODE_MODEL_API_KEY     Credential; provider-specific keys are fallbacks
OPENAI_API_KEY             OpenAI credential fallback
ANTHROPIC_API_KEY          Anthropic credential fallback
OCTOCODE_HOME              Octocode state root through @octocodeai/config
```

Native discovery reads Octocode-managed configuration at both scopes:

| Scope | Models | MCP servers | Skills |
|---|---|---|---|
| Global | `$OCTOCODE_HOME/agent/models.json` | `$OCTOCODE_HOME/agent/mcp/servers.json` | `$OCTOCODE_HOME/agent/skills/` |
| Workspace | `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/models.json` | `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/mcp/servers.json` | `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/skills/` |

`$OCTOCODE_HOME` is normally `~/.octocode`. Initialize the global scope (the
default), the repository containing the current working directory, or both:

```bash
octocode-agent setup --fix
octocode-agent setup --fix --scope project
octocode-agent setup --fix --scope all
```

Setup initializes managed discovery files and directories; it does not create a
provider credential. Use `octocode-agent auth login` or set a supported credential
environment variable before the first model request. `doctor` checks the runtime,
credential presence, and managed model, MCP, and Skill source syntax. It does not
contact provider endpoints or MCP servers.

The discovery inventory also reads compatible Pi, Claude, Cursor, Codex,
Gemini, VS Code, `.agent`, and `.agents` locations. External model definitions
are enabled when their protocol is supported and their workspace source is
trusted. Pi `apiKey` and header values support commands, environment
interpolation, literals, and `$`/`!` escapes; commands run only when a model
request starts. Explicit custom providers can instead use header-only authentication
or no authentication (for example a loopback Ollama endpoint); canonical OpenAI and
Anthropic providers still require credentials. External MCP servers and Skills remain visible but disabled
until you enable the exact source in `/settings`. Run
`octocode-agent discover --json` or `octocode-agent config sources --json` to
inspect every source, path, status, and effective enablement without model
credentials. Credentials are required only when the agent sends a model request.

MCP compatibility imports include user and workspace `.pi/mcp.json`,
`.pi/agent/mcp.json`, Claude, Cursor, Codex, `.agent`, and `.agents` files.
Skill compatibility imports include user and workspace `.pi/skills`,
`.pi/agent/skills`, `.claude/skills`, `.cursor/skills`, `.codex/skills`,
`.agent/skills`, and `.agents/skills`. Imported MCP servers and Skills are
read-only and disabled by default. Use `/settings connections` or
`/settings skills` to enable or disable the exact server, MCP tool, or Skill
source; the override is stored separately from the owning file.

Update the installed launcher and its bundled core together with
`octocode-agent update platform`. The CLI rejects other update targets before it
starts a package-manager process.

Secrets are never rendered in settings projections. Installed Unix builds use the
Rust core and filesystem binaries packaged beside the JavaScript launcher. The Rust actor owns
durable session compare-and-append, session indexes, effect settlement,
automation definitions and runs, and worker-message leases in SQLite. Settings
mutations remain revisioned and atomic. `--no-session` keeps the run in memory.
The separate filesystem service performs bounded, workspace-contained reads,
hashes, atomic replacement, deletion, and external-process path authorization
only after TypeScript schema, trust, approval, and effect checks. TypeScript
still owns process supervision and FFmpeg argument semantics. There is no
production Node fallback. Linux, macOS, and Windows use native
capability-rooted implementations; other targets fail closed.

## Package boundaries

- `@octocodeai/agent-core` owns host-neutral contracts and kernel behavior.
- `octocode-agent` owns file-tool semantics and filesystem ports, plus process,
  provider, transport, renderer-neutral presentation, interactive controller,
  and OpenTUI adapters.
- `octocode-agent-core-rust` owns durable SQLite transactions, revisions,
  leases, fencing tokens, integrity checks, and contained cross-platform filesystem
  primitives. TypeScript owns timing, file schemas/edit semantics, semantic
  execution, policy, and presentation.
- `@octocodeai/pi-extension` owns the retained Pi mapping only.
- `@octocodeai/agent-testing` owns normalized cross-host conformance utilities.

The package build runs a static source/artifact/manifest guard that rejects native Pi-family dependencies. OpenTUI types stay under `src/terminal/opentui/` and noninteractive modes do not initialize the renderer.

## Development

```bash
yarn workspace @octocodeai/agent-core build
yarn workspace octocode-agent typecheck
yarn workspace octocode-agent test
yarn workspace octocode-agent build
yarn workspace octocode-agent check:no-native-pi
yarn workspace octocode-agent verify
node packages/octocode-agent/out/octocode-agent.mjs --help
```

`yarn workspace octocode-agent build` compiles both release Rust services and copies
the platform binaries under `out/native/<platform>-<arch>/`. The built launcher
fails closed if a required packaged binary is missing. Developers can set
`OCTOCODE_AGENT_RUST_CORE_BIN` or `OCTOCODE_AGENT_RUST_CORE_DB` to an absolute
path for an explicit local override. `OCTOCODE_AGENT_RUST_FS_BIN` overrides the
filesystem service with an absolute path. Installed users don't need these variables.

See [`docs/README.md`](docs/README.md) and the repository RFC evidence for architecture, migration, and verification details.
