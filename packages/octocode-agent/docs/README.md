# octocode-agent docs

Docs in this directory belong to the branded native launcher package. Keep native launcher, transport, provider, terminal, persistence, and agent-design research here; do not duplicate package scripts or tool schemas owned by manifests or the live Octocode catalog.

| Document | Owns |
|---|---|
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | Native ownership, module map, event projection, controller/presentation/rendering layers, and dependency rules. |
| [CUSTOMIZATION_API.md](CUSTOMIZATION_API.md) | Versioned programmatic customization for renderers, product policy, tools, hooks, events, durable compaction, portable worker factories, and resolved hardening items. |
| [HEADLESS.md](HEADLESS.md) | One-shot, JSON, RPC, prompt, cache, native base-tool, MCP, automation, Rust-session, and skill behavior. |
| [PARALLELISM_AND_WORKERS.md](PARALLELISM_AND_WORKERS.md) | Bounded tool and parallel MCP concurrency, packaged Rust messaging, root-only worker authorization, leaf children, joins, and verification. |
| [ACP.md](ACP.md) | ACP stdio lifecycle, cancellation, signal, and stop-reason semantics. |
| [SETTINGS.md](SETTINGS.md) | Native `/settings` usage, security boundary, editable values, and current limits. |
| [TERMINAL_DESIGN_SYSTEM.md](TERMINAL_DESIGN_SYSTEM.md) | Shared terminal/browser tokens, Zustand view-state ownership, event-to-surface projection, safe-thinking states, tool summaries, worker summaries, responsive footer behavior, keyboard rules, and UX acceptance criteria. |
| [MONITORING.md](MONITORING.md) | Safe metrics snapshot, provider correlation/timing, cache semantics, and native adapter boundaries. |
| [PERMISSIONS_AND_CONTEXT.md](PERMISSIONS_AND_CONTEXT.md) | Permission modes, HITL invariants, context artifacts, cache-stable assembly, compaction, skills, memory, and session-document summaries. |
| [RELEASE_VALIDATION.md](RELEASE_VALIDATION.md) | Package and repository gates, packed-install, real-command PTY, platform, assistive-output, performance, canary, and rollback evidence. |
| [PI_INTEGRATION.md](PI_INTEGRATION.md) | Historical launcher-to-Pi boundary and current parity-oracle role. |
| [pi-fork.md](pi-fork.md) | Supported Pi fork workflow and compatibility constraints. |
| [coding-agent-failure-modes.md](coding-agent-failure-modes.md) | Research inventory of common coding-agent failures. |
| [coding-agent-mistakes-prevention.md](coding-agent-mistakes-prevention.md) | Prevention checklist mapped to agent/harness behavior. |

Command truth lives in `package.json` scripts and the launcher binary help (`octocode-agent --help`, `octocode-agent config`, `octocode-agent models`). If a command changes, update code/help first and keep docs as routing or rationale only.
