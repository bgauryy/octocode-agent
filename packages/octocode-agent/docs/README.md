# octocode-agent docs

Docs in this directory belong to the branded native launcher package. Keep native launcher, transport, provider, terminal, persistence, and agent-design research here; do not duplicate package scripts or tool schemas owned by manifests or the live Octocode catalog.

| Document | Owns |
|---|---|
| [coding-agent-failure-modes.md](coding-agent-failure-modes.md) | Research inventory of common coding-agent failures. |
| [coding-agent-mistakes-prevention.md](coding-agent-mistakes-prevention.md) | Prevention checklist mapped to agent/harness behavior. |

Command truth lives in `package.json` scripts and the launcher binary help (`octocode-agent --help`, `octocode-agent config`, `octocode-agent models`). If a command changes, update code/help first and keep docs as routing or rationale only.
