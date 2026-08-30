# octocode-agent

The native Octocode coding agent: one command, one update path, and no native Pi dependency.

```bash
npm install -g octocode-agent
octocode-agent setup --fix
octocode-agent
```

The native launcher composes `@octocodeai/agent-core` with:

- OpenAI-compatible model streaming and tool calls;
- the live `octocode` catalog and exact tool schemas;
- transactional native sessions and revisioned settings;
- interactive OpenTUI plus print, JSON, and versioned RPC transports;
- host-neutral lifecycle, policy, hooks, plugin, model, and settings contracts.

`@octocodeai/pi-extension` remains a separately supported adapter for existing Pi users. It is not a dependency of the native launcher.

## Commands

```text
octocode-agent [--] [prompt]     Interactive native terminal (`--` forces prompt parsing)
octocode-agent run <prompt>      One-shot text output
printf 'prompt\n' | octocode-agent run
octocode-agent run --json ...    One-shot JSON events
octocode-agent serve             Versioned JSONL RPC on stdio

octocode-agent config get|set|list|sources
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
octocode-agent tools|skills|memory|awareness
```

Run `octocode-agent --help` for the installed command truth.
See the [headless runtime guide](docs/HEADLESS.md) for prompt composition,
protocol envelopes, caching, MCP, and Agent Skills behavior.

Interactive slash commands include `/help`, `/status`, `/tools`, `/skills`,
`/thinking`, `/steer`, `/clear`, `/compact`, `/plan show`, and
`/settings [section]`.
`/settings` opens the secure loopback configuration center; see the
[settings guide](docs/SETTINGS.md) for its current capabilities and limits.
`/clear` starts a fresh session with empty model context and zero session token
usage. The previous durable session remains available to resume, and its visible
transcript stays on screen for continuity.
`/compact` uses the launcher's durable compaction service. Manual and automatic
compaction commit the validated summary projection before replacing live context.

Use `--model provider/model` on an interactive, `run`, or `serve` invocation to
override the configured model for that process. Add one or more
`--fallback-model provider/model` flags to opt into an ordered preflight chain.
The launcher probes the primary first, selects the first provider that passes,
and fails closed if none pass. It never changes providers implicitly. Run
`octocode-agent models --check` (or add `--json`) to verify the configured default;
the report contains only sanitized readiness and failure categories, never secrets
or provider response bodies.

## Runtime configuration

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

Secrets are never rendered in settings projections. Session and settings writes use restrictive permissions, revision checks, backup recovery, file sync, and atomic rename. Legacy JSONL sessions are imported read-only into a separate native destination.

## Package boundaries

- `@octocodeai/agent-core` owns host-neutral contracts and kernel behavior.
- `octocode-agent` owns filesystem, process, provider, transport, and OpenTUI adapters.
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

See [`docs/README.md`](docs/README.md) and the repository RFC evidence for architecture, migration, and verification details.
