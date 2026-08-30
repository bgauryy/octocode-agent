# octocode-agent docs

Docs in this directory belong to the branded native launcher package. Keep native launcher, transport, provider, terminal, persistence, and agent-design research here; do not duplicate package scripts or tool schemas owned by manifests or the live Octocode catalog.

| Document | Owns |
|---|---|
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | Native package ownership, composition boundaries, and dependency rules. |
| [HEADLESS.md](HEADLESS.md) | One-shot, JSON, RPC, prompt, cache, tool, MCP, and skill behavior. |
| [ACP.md](ACP.md) | ACP stdio lifecycle, cancellation, signal, and stop-reason semantics. |
| [SETTINGS.md](SETTINGS.md) | Native `/settings` usage, security boundary, editable values, and current limits. |
| [MONITORING.md](MONITORING.md) | Safe metrics snapshot, provider correlation/timing, cache semantics, and native adapter boundaries. |
| [RELEASE_VALIDATION.md](RELEASE_VALIDATION.md) | Packed-install, platform, assistive-output, performance, canary, and rollback evidence. |
| [PI_INTEGRATION.md](PI_INTEGRATION.md) | Historical launcher-to-Pi boundary and current parity-oracle role. |
| [coding-agent-failure-modes.md](coding-agent-failure-modes.md) | Research inventory of common coding-agent failures. |
| [coding-agent-mistakes-prevention.md](coding-agent-mistakes-prevention.md) | Prevention checklist mapped to agent/harness behavior. |

Command truth lives in `package.json` scripts and the launcher binary help (`octocode-agent --help`, `octocode-agent config`, `octocode-agent models`). If a command changes, update code/help first and keep docs as routing or rationale only.
