# Native settings control center

Use `/settings` in the interactive native terminal to open the local configuration
center. Add an optional section name, such as `/settings models`, to open a matching
anchor when that section is present.

## Current capabilities

The page shows a redacted, allowlisted view of runtime configuration. The shared
registry defines five public global values:

- Theme.
- Reduced motion, which defaults to static output.
- Default provider.
- Default model.
- Compaction input-token threshold (4,096 through 2,000,000; default 64,000).
  Automatic compaction compares this value with the latest provider request's
  input-token occupancy, not cumulative billed input across the session.

The launcher creates one canonical core settings registry/service and shares it
with runtime model selection and this page. Successful changes apply to the next
session. Before committing, the Models form resolves the provider and model against
the same effective catalog as the CLI and runtime. It rejects missing, disabled, or
unsupported selections and saves a valid provider and model together, so the runtime
never observes half of a selection. Mutations use the service revision, preserve unrelated stored values, and
publish memory state only after the atomic file commit succeeds. The page does not
expose arbitrary stored values or secret-shaped legacy values.

The hooks and plugins sections project the native extension controller's current
discovery and activation state. They also expose exact-hash review and explicit
plugin capability grant/revoke actions. Missing review or permission grants nothing.

When the native capability control is composed, the page lists MCP servers, MCP
tools, and Skills with their vendor and source path. It can change MCP state,
change an exact Skill source's state, or refresh the Skill catalog. These actions use a separate capability
revision and the same persisted lifecycle authority consumed by the runtime. A
missing control or stale revision fails closed.

The Connections section groups provider endpoints, MCP servers, MCP tools, and the
MCP Tasks capability note. MCP Tasks appears as available only when a configured
server negotiates that versioned capability; generic MCP connectivity does not
imply task support.
For the active native runtime, each MCP server also reports connection state,
catalog state (`not-loaded`, `ready`, `stale`, or `empty`), last refresh, tool
count, and a bounded sorted tool-name list. A server `tools/list_changed`
notification marks the catalog stale immediately. Negotiated catalog changes don't
change the Settings revision because they aren't persisted configuration.

The **User configuration** section exports only portable public settings. Import and
reset use the same optimistic, atomic settings service as CLI changes. Reset
removes registered settings but preserves unrelated legacy keys without exposing
their values.

`octocode-agent config list` returns only the public CLI allowlist. Unknown legacy
keys and their values remain in storage but do not appear in command output.
`config set` uses the same typed service as the page. `models --set` commits provider
and model together in one optimistic transaction, so neither half is published when
validation or persistence fails.

Runtime model selection resolves through the core `ModelCatalog`. Canonical OpenAI
and Anthropic entries form the base source. Native and Pi-compatible
`models.json` files add provenance-tracked model definitions. Valid persisted
settings select from that file-backed catalog. Environment variables can satisfy
credential references, but they don't create providers or models. Legacy
`OCTOCODE_MODEL`, `OCTOCODE_MODEL_PROTOCOL`, and `OCTOCODE_MODEL_ENDPOINT` values
are ignored; define the provider protocol, endpoint, and model IDs in `models.json`.
Within an active runtime, `model.select` can change models only inside the startup
provider. Changing providers requires a new session so Octocode can recompose the
wire protocol, endpoint, credentials, thinking policy, and compaction route together.

Pi imports fail closed when they contain compatibility semantics that the native
adapter cannot preserve. Discovery reports the unsupported keys and does not advertise
tools, thinking, or caching for that entry. `octocode-agent models` reports the effective
selection and source separately from the persisted override and credential readiness.
`octocode-agent models --check` is the credential-gated live canary; missing credentials
produce `SKIP` and a failing exit status, never a release pass.

Runtime support is protocol-level. The executable adapters are
`openai-chat-completions`, `openai-responses`, and `anthropic-messages`. Native
Octocode runs a custom vendor only when it conforms to one of those wire protocols.
Gemini/Vertex, Bedrock, Azure deployment/API-version authentication, Mistral
Conversations, and other provider-specific protocols remain visible as unsupported
provenance; the catalog doesn't advertise them as runnable. Explicit custom providers can
use an API key, custom headers only, or no authentication. The last form is intended
for trusted local endpoints; canonical cloud providers continue to require a key.

Pi model files are linked read-only and keep Pi provenance. Settings offers **Adopt Pi
model as native default**, which saves only the provider/model selection. It never copies
the Pi credential. Pi `api_key` credentials remain request-time inputs; OAuth and typed
cloud credential chains require dedicated native provider profiles.

Provider entries may set `promptCaching.mode` to `auto`, `enabled`, or `disabled`.
`auto` enables cache hints only on the canonical Anthropic and OpenAI hosts.
Anthropic uses ephemeral prefix caching with a five-minute TTL by default;
OpenAI receives a stable prompt cache key. `enabled` explicitly enables the
selected adapter's cache hint for compatible custom endpoints;
`disabled` suppresses it. Model cost entries may also include numeric `cacheRead`
and `cacheWrite` per-million prices. Discovery preserves unknown prices as unavailable.
See [MONITORING.md](MONITORING.md) for normalized token and metric semantics.

Compaction runs through the normal `compaction.started` decision hook before the
summary request. A stop/deny decision aborts compaction. Ordered hook context is
appended after the stable system-and-history prefix, which lets extensions customize
the summary without destroying provider cache affinity across retries.

## Discovery sources

Run `octocode-agent setup --fix` to create the managed global files and Skill
directory. Use `--scope project` to initialize the repository containing the
current working directory, even when invoked from a nested directory. Use
`--scope all` to initialize both scopes. Setup preserves existing files.

| Capability | Global managed source | Repository managed source | Compatibility sources | Default |
|---|---|---|---|---|
| Models | `$OCTOCODE_HOME/agent/models.json` | `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/models.json` | Pi user and workspace `models.json` files | Enabled when the protocol is supported and the workspace source is trusted |
| MCP | `$OCTOCODE_HOME/agent/mcp/servers.json` | `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/mcp/servers.json` | Pi, Claude, Cursor, Codex, Gemini, VS Code, Copilot, `.agent`, and `.agents` files at user and workspace scopes | Compatibility sources disabled |
| Skills | `$OCTOCODE_HOME/agent/skills/` | `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/skills/` | Pi, Claude, Cursor, Codex, `.agent`, and `.agents` directories at user and workspace scopes | Compatibility sources disabled |
Repository definitions override matching global definitions. Repository sources
remain visible in discovery output, but runtime use requires workspace trust.

Pi MCP imports include `.pi/mcp.json` and `.pi/agent/mcp.json`. Skill imports
include `.pi/skills`, `.pi/agent/skills`, `.claude/skills`, `.cursor/skills`,
`.codex/skills`, `.agent/skills`, and `.agents/skills`. Each relative path is
checked under the home directory and every repository directory from the repository
root through the current working directory.

`octocode-agent discover [models|mcp|skills] --json` and
`octocode-agent config sources --json` read the same source inventory used by
the native launcher and settings page. Discovery is side-effect-free: it does
not contact model providers, connect MCP servers, or load Skill bodies into a
model request. Invalid sources remain visible with diagnostics and contribute
nothing to the effective runtime.

When native settings do not select a model, the launcher follows Pi's global
`~/.pi/agent/settings.json` selection and a trusted workspace `.pi/settings.json`
override. If a provider was renamed, a stale provider ID is accepted only when
the selected model ID resolves to exactly one enabled Pi provider. Environment
model overrides remain highest precedence.

For Pi-selected providers, the launcher reads the exact provider credential from
`~/.pi/agent/auth.json` before falling back to the provider's `apiKey` in
`models.json`. When Pi's selected provider ID resolves to a uniquely matching
renamed provider, credential lookup checks the resolved ID first and the original
Pi selection ID second. Only `api_key` credentials are supported. OAuth and
malformed credentials fail closed with a public diagnostic.

Pi API keys and header values preserve command, environment interpolation,
literal, `$$`, and `$!` forms, including credential-local environment values from
`auth.json`. Secret commands run at model request time. Listing sources and
opening the terminal don't execute them. The launcher reads credentials only
from regular, non-symbolic-link files no larger than 1 MiB. Provider URLs containing
user information, query parameters, or fragments are rejected so credentials
can't leak through discovery output.

Model discovery, `doctor`, and `auth status` report the selected provider's
credential readiness without returning credential values. Environment variables
referenced by custom Pi providers are included, and `auth login` can store those
keys alongside the built-in OpenAI and Anthropic choices. Command-backed
credentials are reported as configured but remain request-time verified.

Skill enablement is stored per source ID. This keeps duplicate names independent:
enabling an external Skill does not also enable or replace a managed copy with
the same name. Copy the source ID shown beside the Skill into the settings form.
MCP server and tool enablement is also stored separately from the imported file.
The settings page can enable or disable a whole server, an individual discovered
tool, or one exact Skill source without editing the owning Pi, Claude, Cursor,
Codex, `.agent`, or `.agents` file.

## Security boundary

The native process serves the page only on a loopback address. Requests require the
expected Host and Origin, a per-page action token, bounded POST-only JSON, and a known
mutation. Responses use a restrictive Content Security Policy, `no-store`, nosniff,
and HTML escaping. Closing the native process stops the server.

Treat the URL and action token as session-local capabilities. Do not publish or proxy
the page, and do not use it as a remote administration endpoint.

## Current limits

This slice does not complete the settings RFC. Portable public-settings import,
reset, and default-model selection are implemented. Provider/model definition
CRUD, editing discovered source files, session management and
recovery, complete diagnostics, packaged browser/accessibility coverage, and
native/Pi conformance remain gated work.
Extension execution also remains trust-, review-, capability-, and host-adapter
dependent; changing a setting does not grant executable authority by itself.

For command-line automation, use `octocode-agent config get|set|list|sources`. The browser
page is a human-facing adapter and does not define a separate settings contract.
