# octocode-agent docs

Docs in this directory belong to the branded launcher package. Keep launcher, Pi-host integration, and agent-design research here; do not duplicate package scripts or tool schemas that are owned by manifests or the Pi extension docs.

| Document | Owns |
|---|---|
| [PI_INTEGRATION.md](PI_INTEGRATION.md) | How `octocode-agent` launches Pi with `@octocodeai/pi-extension`, user-facing commands, packaging, and integration risks. |
| [pi-fork.md](pi-fork.md) | Pi fork development and override workflow. |
| [coding-agent-failure-modes.md](coding-agent-failure-modes.md) | Research inventory of common coding-agent failures. |
| [coding-agent-mistakes-prevention.md](coding-agent-mistakes-prevention.md) | Prevention checklist mapped to agent/harness behavior. |

Command truth lives in `package.json` scripts and the launcher binary help (`octocode-agent --help`, `octocode-agent config`, `octocode-agent models`). If a command changes, update code/help first and keep docs as routing or rationale only.
