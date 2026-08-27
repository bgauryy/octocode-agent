# MCP client support

Octocode is an MCP 2026-07-28 client built on the stable `@modelcontextprotocol/client` v2 package. It negotiates the newest mutually supported protocol version and supports both standard client transports:

- local `stdio` processes;
- remote Streamable HTTP endpoints, including configured request headers.

Legacy SSE and WebSocket configuration are intentionally unsupported because they are not current MCP client transports. Octocode does not advertise optional client capabilities such as elicitation unless it has a user interaction handler for them.

## Configuration

There is one definition file per scope:

| Scope | File |
|---|---|
| Global | `$OCTOCODE_HOME/agent/mcp/servers.json` (normally `~/.octocode/agent/mcp/servers.json`) |
| Project | `<workspace>/.octocode/agent/mcp/servers.json` |

Project configuration runs only in a trusted workspace. A project definition with the same server name overrides the global definition. The built-in `octocode` stdio server is always present unless disabled in the manager.

Stdio example:

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@acme/docs-mcp@1.2.3"],
      "cwd": ".",
      "env": { "SERVICE_TOKEN": "..." },
      "timeoutMs": 30000
    }
  }
}
```

Streamable HTTP example:

```json
{
  "mcpServers": {
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "timeoutMs": 30000
    }
  }
}
```

Only configure trusted servers. Secret values remain in `servers.json`; generated pages, discovery files, and the agent guide expose key names but redact values.

## Discovery and token-efficient guidance

At session startup Octocode connects to every enabled server and discovers its instructions and tools. Resources, resource templates, prompts, and completion are available through `MCPTool`. Tool, resource, and prompt list-change signals invalidate the affected catalog.

The private workspace catalog is stored under:

```text
$OCTOCODE_HOME/agent/mcp/workspaces/<workspace-digest>/
├── catalog.json
└── mcp.md
```

By default, the first agent system prompt receives every enabled server/tool name, description, and exact input schema from `catalog.json`; `mcp.md` is ignored. Setting `OCTOCODE_COMPACT_MCP=1` opts into the compact flow: a matching `catalog.json` plus validated `mcp.md` is consumed immediately, while a cold or changed catalog is discovered and compiled before the first turn. The generated response must cover every exact server/tool name or it is rejected; a deterministic schema-aware generator is the fallback.

In compact mode the generated guide keeps tool purpose and the invocation-critical parts of the input schema—required fields, types, enums, defaults, constraints, and parameter relationships—without injecting raw schemas. Exact schemas remain in `catalog.json` and are validated internally immediately before a call. Resources, templates, and prompts remain available through explicit `MCPTool` operations but are not added to the tool-focused startup catalog.

Interactive sessions report discovery progress and whether the prompt uses the exact or compact catalog. `/mcp` shows the active mode, artifact paths, and whether a post-start mutation requires `/new` to refresh model routing.

Configuration changes invalidate and refresh the catalog and guide automatically. Catalog and guide files use private permissions on POSIX systems.

## Enablement state and `/settings`

Run `/settings` to rebuild and open the loopback-only Octocode control center; it lists every live public slash command alongside skills, MCP servers/tools, prompt state, sources, and overrides. It opens the skills section by default and accepts section completions, including `commands`. `/mcp` remains the focused alias that opens MCP connections. The center shows managed definitions plus MCP configurations discovered from Claude, Cursor, Codex, Antigravity/Gemini, `.agents`, `.agent`, VS Code, and Claude Desktop locations. Foreign definitions are collision-safe, read-only imports; every imported server and tool is disabled by default.

The complete section-by-section UI, persistence, security, refresh, and limitation reference is [`packages/octocode-pi-extension/docs/SETTINGS.md`](../packages/octocode-pi-extension/docs/SETTINGS.md).

Enablement overrides are stored in Octocode's shared SQLite database, not copied into JSON definitions. Workspace overrides take precedence over global overrides, then the file's `disabled` default. A disabled tool remains visible in the manager so it can be re-enabled, but it is absent from agent guidance and blocked at execution.

The shared-theme page provides search, source visibility, redacted configuration, health, OAuth/connect actions, server/tool/skill enablement, prompt mode, and overrides in one place. Skill files remain untouched; normalized global/workspace skill overrides share the SQLite state and precedence model used for MCP enablement. Mutation requests require the page's unguessable action token.

## MCPTool operations

The extension discovers enabled tools during initialization; there is no model-callable tool-list action. The agent uses `MCPTool` to describe one unfamiliar tool, call tools, list/read resources and templates, list/get prompts and complete arguments, inspect status/config, toggle servers or tools, and restart, stop, add, or remove servers.

The client automatically follows paginated list responses and reacts to MCP list-change signals. Request cancellation and configured timeouts propagate through the client.

## Deliberate boundaries

- Stable Streamable HTTP OAuth uses browser authorization with PKCE and loopback callback handling; tokens stay in the OS credential store.
- Roots expose only the trusted active workspace. Sampling and form/URL elicitation require explicit interactive approval and fail closed in headless sessions; logging/progress notices are sanitized.
- Experimental draft capabilities and legacy SSE fallback are intentionally unsupported.

## Troubleshooting

| Problem | Check |
|---|---|
| Server missing | Canonical path, JSON validity, project trust, and server enablement in `/settings`. |
| Stdio server exits | Keep protocol messages on stdout and logs on stderr; confirm command, cwd, and env keys. |
| HTTP connection fails | Confirm an HTTP(S) Streamable HTTP URL and required header values. |
| Tool missing from agent guidance | Check its enablement in `/settings`; the manager retains disabled tools. |
| Schema validation fails | Inspect the current schema with `MCPTool` describe and correct the arguments. |
