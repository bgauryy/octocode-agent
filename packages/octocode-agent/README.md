# octocode-agent

The native Octocode coding agent: one command, one update path, and no native Pi dependency.

```bash
npm install -g octocode-agent
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
octocode-agent [prompt]          Interactive native terminal
octocode-agent run <prompt>      One-shot text output
printf 'prompt\n' | octocode-agent run
octocode-agent run --json ...    One-shot JSON events
octocode-agent serve             Versioned JSONL RPC on stdio

octocode-agent config get|set|list
octocode-agent setup [--fix]
octocode-agent auth [login]
octocode-agent models [--set provider/model]
octocode-agent sessions
octocode-agent resume [session]
octocode-agent session [args]
octocode-agent doctor
octocode-agent update [platform|core]
octocode-agent completion bash|zsh|fish
octocode-agent tools|skills|memory|awareness
```

Run `octocode-agent --help` for the installed command truth.
See the [headless runtime guide](docs/HEADLESS.md) for prompt composition,
protocol envelopes, caching, MCP, and Agent Skills behavior.

Interactive slash commands include `/help`, `/status`, `/tools`, `/skills`,
`/thinking`, `/steer`, `/compact`, `/plan show`, and `/settings [section]`.
`/settings` opens the secure loopback configuration center; see the
[settings guide](docs/SETTINGS.md) for its current capabilities and limits.
`/compact` is capability-gated and reports unsupported until the launcher composes
the durable compaction port.

## Runtime configuration

The native model adapter accepts OpenAI-compatible endpoints:

```text
OCTOCODE_MODEL_API_KEY     Credential; OPENAI_API_KEY is the fallback
OCTOCODE_MODEL_ENDPOINT    Base URL; defaults to https://api.openai.com/v1
OCTOCODE_MODEL             Default model; settings are used as a fallback
OCTOCODE_HOME              Octocode state root through @octocodeai/config
```

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
node packages/octocode-agent/out/octocode-agent.mjs --help
```

See [`docs/README.md`](docs/README.md) and the repository RFC evidence for architecture, migration, and verification details.
