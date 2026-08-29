# Native settings control center

Use `/settings` in the interactive native terminal to open the local configuration
center. Add an optional section name, such as `/settings models`, to open a matching
anchor when that section is present.

## Current capabilities

The page shows a redacted, allowlisted view of runtime configuration. The shared
registry defines three global values:

- theme; and
- default provider; and
- default model.

The launcher creates one canonical core settings registry/service and shares it
with runtime model selection and this page. Successful changes apply to the next
session. Mutations use the service revision, preserve unrelated stored values, and
publish memory state only after the atomic file commit succeeds. The page does not
expose arbitrary stored values or secret-shaped legacy values.

The hooks and plugins sections project the native extension controller's current
discovery and activation state. They also expose exact-hash review and explicit
plugin capability grant/revoke actions. Missing review or permission grants nothing.

When the native capability control is composed, the page lists MCP servers, MCP
tools, and Skills. It can enable or disable an MCP server or tool, enable or disable
a Skill, or refresh the Skill catalog. These actions use a separate capability
revision and the same persisted lifecycle authority consumed by the runtime. A
missing control or stale revision fails closed.

`octocode-agent config list` returns only the public CLI allowlist. Unknown legacy
keys and their values remain in storage but do not appear in command output.
`config set` uses the same typed service as the page. `models --set` commits provider
and model together in one optimistic transaction, so neither half is published when
validation or persistence fails.

Runtime model selection resolves through the core `ModelCatalog`. Canonical OpenAI
and Anthropic entries form the base source; valid persisted settings override that
base; `OCTOCODE_MODEL`, `OCTOCODE_MODEL_PROTOCOL`, and
`OCTOCODE_MODEL_ENDPOINT` form the highest-precedence runtime source. A custom
OpenAI-compatible endpoint remains explicit and defaults to Chat Completions unless
the protocol environment value selects another supported adapter.

## Security boundary

The native process serves the page only on a loopback address. Requests require the
expected Host and Origin, a per-page action token, bounded POST-only JSON, and a known
mutation. Responses use a restrictive Content Security Policy, `no-store`, nosniff,
and HTML escaping. Closing the native process stops the server.

Treat the URL and action token as session-local capabilities. Do not publish or proxy
the page, and do not use it as a remote administration endpoint.

## Current limits

This slice does not complete the settings RFC. Provider/model CRUD, model-source
import and refresh, session management, recovery, complete diagnostics, packaged
browser/accessibility coverage, and native/Pi conformance remain gated work.
Extension execution also remains trust-, review-, capability-, and host-adapter
dependent; changing a setting does not grant executable authority by itself.

For command-line automation, use `octocode-agent config get|set|list`. The browser
page is a human-facing adapter and does not define a separate settings contract.
