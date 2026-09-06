# Documentation

Use these guides for repository-wide configuration and capability discovery.
Package ownership and implementation details stay with each package.

| Guide | What it covers |
|---|---|
| [Completion ledger](../DESIGN/LEFTOVERS.md) | Settled ownership, verified candidate capabilities, remaining work, and release closure gates. |
| [MCP servers and skills](MCP.md) | Configure external stdio MCP servers. Install or create Agent Skills. Inspect capability discovery. |
| [Capability discovery](DISCOVERY.md) | Advanced reference for MCP catalog initialization, skill discovery, the `.octocode/discovery.json` inventory, and observability surfaces. |
| [Documentation audit and ratings](DOCUMENTATION_AUDIT.md) | Documentation authority, quality ratings, known gaps, and maintenance rules. |

## Package documentation

| Package | Architecture | Documentation |
|---|---|---|
| Agent core | [Architecture](../packages/octocode-agent-core/ARCHITECTURE.md) | [README](../packages/octocode-agent-core/README.md) |
| Rust native services | [Architecture](../packages/octocode-agent-core-rust/ARCHITECTURE.md) | [README](../packages/octocode-agent-core-rust/README.md) |
| Agent testing | [Architecture](../packages/octocode-agent-testing/ARCHITECTURE.md) | [README](../packages/octocode-agent-testing/README.md) |
| Native agent | [Architecture](../packages/octocode-agent/ARCHITECTURE.md) | [Index](../packages/octocode-agent/docs/README.md) |
| Pi extension | [Architecture](../packages/octocode-pi-extension/ARCHITECTURE.md) | [Index](../packages/octocode-pi-extension/docs/README.md) |
| Awareness | [Architecture](https://github.com/bgauryy/octocode/tree/main/packages/octocode-awareness/ARCHITECTURE.md) | [Index](https://github.com/bgauryy/octocode/tree/main/packages/octocode-awareness/docs/README.md) |
| Shared contracts | [Architecture](../packages/octocode-shared/ARCHITECTURE.md) | [README](../packages/octocode-shared/README.md) |

[`DESIGN/LEFTOVERS.md`](../DESIGN/LEFTOVERS.md) is the only live repository-level
completion plan. Keep implementation detail in the owning package architecture or
operational guide instead of adding development evidence under `DESIGN/`.
