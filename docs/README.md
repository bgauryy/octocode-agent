# Docs

Cross-package documentation for the Octocode agent monorepo. Package internals
stay package-local (`packages/*/docs`); this shelf holds harness-wide topics.

| Doc | What it covers |
|---|---|
| [DISCOVERY.md](DISCOVERY.md) | Capability discovery end to end: MCP init discovery + the `<mcp_catalog>` prompt block (smart caching), the `skill` tool + skill discovery across common ecosystem roots, the `.octocode/discovery.json` inventory (skills + MCP config discoverability), observability surfaces, and the measured context composition. |

Package docs: [pi-extension](../packages/octocode-pi-extension/docs/README.md) ·
[awareness](../packages/octocode-awareness/docs/README.md) ·
[agent](../packages/octocode-agent/docs/README.md)
