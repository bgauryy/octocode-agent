# Octocode harness — capability discovery, MCP config, and skills

How native `octocode-agent` discovers MCP servers and Agent Skills. This page owns
shared concepts and the cross-host source inventory. Native runtime behavior is owned by
[`HEADLESS.md`](../packages/octocode-agent/docs/HEADLESS.md). The independent Pi extension
has its own, much smaller MCP and skill loading, documented in
[its README](../packages/octocode-pi-extension/README.md).

The native runtime uses the Agent Skills parser from `@octocodeai/agent-contracts` and
exposes model-facing `skill` and `MCPTool` facades.

---

## 1. Native flow

```text
native startup
 ├─ build the shared Octocode prompt
 ├─ load hierarchical repository instructions
 ├─ load and cache the live Octocode tool catalog
 ├─ discover enabled Agent Skills
 └─ create MCP clients for explicit actions through the native MCP adapter
```

The native host loads managed models, MCP servers, and Skills from global
`$OCTOCODE_HOME/agent/models.json`, `$OCTOCODE_HOME/agent/mcp/servers.json`, and
`$OCTOCODE_HOME/agent/skills/` sources. Repository scope uses the corresponding
`$OCTOCODE_HOME/agent/workspaces/<workspace-key>/` sources. It uses the official MCP client for
stdio and Streamable HTTP, validates tool arguments with Ajv, resolves secret
references only at connection time, constrains stdio working directories to the
workspace, and supports tools, resources, prompts, and completion. SQLite server/tool
overrides apply before connection. Foreign-host MCP files remain discovery-only and
disabled until explicitly enabled through the owning settings flow.

Native model compatibility reads Pi provider definitions and selection from
`~/.pi/agent/models.json` and `~/.pi/agent/settings.json`. For the selected Pi
provider, a stored `api_key` in `~/.pi/agent/auth.json` takes precedence over the
provider definition's fallback key. Credential discovery supports Pi's original
provider ID when a unique model match resolves it to a renamed provider. It rejects
OAuth, malformed entries, symbolic links, and oversized credential files without
including secret values in discovery or runtime output.

The native model catalog is file-backed: canonical definitions plus global/workspace
Octocode and Pi `models.json` sources. Persisted Settings and explicit CLI model choices
select entries; environment variables don't define providers, endpoints, protocols, or
model IDs. They may only resolve credential references at request time. Settings exposes
each source's provenance, sanitized endpoint host, protocol support, enabled state, and
credential readiness. Its Pi adoption action persists only the provider/model default and
continues to link the Pi files read-only—credential bytes are never copied.

---

## 2. MCP config discoverability

Native discovery reports every existing MCP config file found in these project and user
locations, covering managed and compatibility inventory:

| Host | Project locations | User locations | Activation |
|---|---|---|---|
| Octocode | `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/mcp/servers.json` | `$OCTOCODE_HOME/agent/mcp/servers.json` | Active |
| Claude Code/Desktop | Official `<ws>/.mcp.json`; compatibility `<ws>/.claude/mcp.json` | `~/.claude.json`, `~/.claude/mcp.json`, and Claude Desktop platform config | Discovered, disabled by default |
| Cursor | `<ws>/.cursor/mcp.json` | `~/.cursor/mcp.json` | Discovered, disabled by default |
| Codex | `<ws>/.codex/config.toml` | `~/.codex/config.toml` | Discovered, disabled by default |
| Gemini CLI | `<ws>/.gemini/settings.json` | `~/.gemini/settings.json` | Discovered, disabled by default |
| Antigravity | `<ws>/.agents/mcp_config.json` | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json` | Discovered, disabled by default |
| Agent compatibility | `<ws>/.agents/mcp.json`, `<ws>/.agent/{mcp,mcp_config}.json` | Matching `~/.agents` and `~/.agent` files | Discovered, disabled by default; a compatibility convention, not part of AGENTS.md |
| VS Code / Copilot | `<ws>/.vscode/mcp.json` | `~/.vscode/mcp.json`, `~/.copilot/mcp-config.json` | Discovered, disabled by default |

The global canonical file loads first, followed by the trusted project's canonical file.
The built-in `octocode` server is lower than both file-based entries.

**Security boundary:** foreign definitions are normalized under collision-safe names such as
`cursor.docs`, but every discovered server and tool fails closed until an operator explicitly
enables it in `/mcp`. Project imports additionally require workspace trust. Their owning files
remain read-only; canonical Octocode JSON owns managed definitions, SQLite owns only enablement,
and the OS credential store owns OAuth tokens. Malformed files receive an `error` field instead of aborting discovery.

Host references: [Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Cursor MCP](https://cursor.com/docs/mcp),
[Codex MCP](https://developers.openai.com/codex/mcp/), and
[AGENTS.md](https://agents.md/).

---

## 3. Where things live

| Concern | Source | Tests |
|---|---|---|
| Shared Agent Skills parsing/discovery | `packages/octocode-agent-contracts/src/agent-skills.ts` | `packages/octocode-agent-contracts/tests/agent-skills.test.ts` |
| Native MCP and Skill runtime adapters | `packages/octocode-agent/src/native-mcp.ts`, `src/native-skills.ts` | `tests/native-agent-capabilities.test.ts`, `tests/native-mcp-real-host.test.ts`, `tests/native-skill-discovery.test.ts` |
| Native cross-host discovery and controls | `packages/octocode-agent/src/native-discovery.ts`, `src/native-settings-service.ts` | `tests/native-discovery-built-host.test.ts`, `tests/native-settings-service.test.ts` |

Related package docs: [`packages/octocode-agent/docs/HEADLESS.md`](../packages/octocode-agent/docs/HEADLESS.md)
for native behavior and [`packages/octocode-pi-extension/README.md`](../packages/octocode-pi-extension/README.md)
for the Pi extension.
