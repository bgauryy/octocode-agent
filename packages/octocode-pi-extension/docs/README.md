# @octocodeai/pi-extension docs

Docs in this directory belong to the Pi harness extension. Keep harness runtime, bundled tools, Awareness wiring, prompt/override behavior, and Pi UI notes here. Exact tool field schemas remain generated/runtime-owned: use `node $OCTOCODE_CLI tools <name> --scheme`.

| Document | Owns |
|---|---|
| [TOOLS.md](TOOLS.md) | Tool inventory, routing rules, CLI schema lookup, and Awareness-as-CLI guidance. |
| [AWARENESS_AGENT_FLOW.md](AWARENESS_AGENT_FLOW.md) | Agent lifecycle for using Awareness inside Pi sessions. |
| [REFLECT.md](REFLECT.md) | Reflection and memory workflow as exposed through the harness. |
| [OVERRIDES.md](OVERRIDES.md) | Why and how the extension replaces selected Pi built-ins. |
| [AGENT_ORCHESTRATOR.md](AGENT_ORCHESTRATOR.md) | Pi SDK subagent orchestration contract and rollback notes. |
| [CRON.md](CRON.md) | Session job safety model and cron-style maintenance commands. |
| [UI.md](UI.md) | Octocode Pi UI surfaces and troubleshooting. |

Do not add package command catalogs here. Package scripts are manifest-owned; user-facing launcher commands belong in `packages/octocode-agent/docs/PI_INTEGRATION.md` or launcher help.
