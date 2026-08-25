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

On startup, a matching `catalog.json` plus `mcp.md` is consumed directly into the first agent system prompt. When either file is missing or the effective MCP configuration/tool catalog changed, the active model receives every enabled tool's exact name, description, and input schema and generates a concise routing description. The response must cover every exact server/tool name or it is rejected. Octocode then saves the compiled guide as `mcp.md`; a deterministic schema-aware generator is the fallback when model generation is unavailable or invalid.

The generated guide keeps tool purpose and the invocation-critical parts of the input schema—required fields, types, enums, defaults, constraints, and parameter relationships—without exposing raw schemas on every turn. Exact schemas remain in `catalog.json` and are validated internally immediately before a call. Resources, templates, and prompts remain available through explicit `MCPTool` operations but are not added to this tool-focused startup guide.

Interactive sessions report whether startup reused cached `mcp.md`, is discovering and generating it, or saved a new guide. A matching catalog is reused without another model call.

Configuration changes invalidate and refresh the catalog and guide automatically. Catalog and guide files use private permissions on POSIX systems.

## Enablement state and `/mcp`

Run `/mcp` to open the local MCP manager. It shows all configured servers, redacted transport configuration, connected tools, source files, overrides, and server/tool Enable or Disable controls.

Enablement overrides are stored in Octocode's shared SQLite database, not copied into JSON definitions. Workspace overrides take precedence over global overrides, then the file's `disabled` default. A disabled tool remains visible in the manager so it can be re-enabled, but it is absent from agent guidance and blocked at execution.

The page is served only on loopback, uses same-origin POST actions, and shares the common Octocode HTML theme used by other generated local pages.

## MCPTool operations

The agent uses one `MCPTool` gateway instead of registering every remote tool in the model prompt. It can list/describe/call tools; list/read resources and templates; list/get prompts and complete arguments; inspect status/config; toggle servers or tools; and restart, stop, add, or remove servers.

The client automatically follows paginated list responses and reacts to MCP list-change signals. Request cancellation and configured timeouts propagate through the client.

## Deliberate boundaries

- OAuth authorization is not synthesized from static JSON. Streamable HTTP accepts explicit headers; a future interactive authorization provider must own OAuth redirect and token storage.
- Elicitation is an optional MCP client feature and is not advertised until Octocode can route requests to a user interaction handler.
- Deprecated roots, sampling, and logging client surfaces are not newly implemented. Current core server primitives—tools, resources, and prompts—are supported.

## Troubleshooting

| Problem | Check |
|---|---|
| Server missing | Canonical path, JSON validity, project trust, and server enablement in `/mcp`. |
| Stdio server exits | Keep protocol messages on stdout and logs on stderr; confirm command, cwd, and env keys. |
| HTTP connection fails | Confirm an HTTP(S) Streamable HTTP URL and required header values. |
| Tool missing from agent guidance | Check its enablement in `/mcp`; the manager retains disabled tools. |
| Schema validation fails | Inspect the current schema with `MCPTool` describe and correct the arguments. |
