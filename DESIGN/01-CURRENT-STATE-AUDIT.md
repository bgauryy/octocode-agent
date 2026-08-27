# Current-State Audit

## Verdict

The RFC is not fully executed. The repository contains useful contracts and partial primitives, but the native production composition does not yet provide the required agentic loop, session continuity, interactive TUI, settings control plane, executable hooks, plugin lifecycle, or real-host conformance.

| Area               | Status  | Release blocker                                                                                             |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------- |
| Runtime and policy | Blocked | Effects can bypass trust, approval, plan, and peer-lock decisions.                                          |
| Models and tools   | Blocked | Prompt history, schema validation, thinking controls, typed streaming failures, and retries are incomplete. |
| Sessions           | Blocked | Resume selects a record but does not restore model-visible history.                                         |
| TUI                | Blocked | The OpenTUI implementation is a text sink; canonical interactions are unsupported.                          |
| Settings           | Blocked | Native settings is not production-reachable and native/Pi settings are not one service.                     |
| Hooks              | Blocked | Discovery/parsing exists without executable pre-effect dispatch.                                            |
| Plugins            | Blocked | Activation is not production-wired and grants do not fully constrain contributions.                         |
| Transports         | Blocked | Lifecycle ordering, concurrency, validation, correlation, and exit semantics are incomplete.                |
| Conformance        | Blocked | Existing scenarios use synthetic handlers rather than the real Pi and native hosts.                         |
| Pi removal         | Blocked | Native parity and rollback gates are not satisfied.                                                         |

## Highest-risk implementation facts

- The kernel evaluates tools with a hard-coded unknown workspace trust context, while the native production policy allows all read and network effects.
- Lifecycle observation happens after runtime events; it cannot gate or rewrite the effect that already occurred.
- Interactive and RPC loops await the active command, preventing steer, follow-up, and cancellation from arriving while streaming.
- Runtime shutdown can race an active turn and produce events after `runtime.stopped`.
- Every model request is built from only the latest user message; resumed transcript context is discarded.
- `--no-session` still creates and writes a filesystem session.
- Session CAS is not atomic across processes, migration can mutate its destination before source stability is confirmed, and compaction is not production-wired.
- OpenTUI owns only a text renderable while Node readline separately consumes stdin.
- Native `/settings` has no launcher path, and raw stored values can reach CLI output.
- Hooks have schemas and catalogs but no command/MCP execution engine.
- Plugin leases and production activation are disconnected.
- The conformance harness can pass without invoking either real host.

## Positive controls worth retaining

- The Pi local settings server binds loopback, validates host/origin/token/body size, applies realpath containment for static files, disables caching, and rotates its action token per open.
- Native mode branching avoids constructing the terminal in print and RPC modes, though static OpenTUI loading still violates strict dependency isolation.
- Session storage uses temporary files, rename, backups, and file/directory sync attempts; these are a sound base once concurrency and recovery semantics are corrected.
- Contracts already name many required capabilities and provide a useful vocabulary for production composition.

## Status policy

Planning, readiness, and release documents must distinguish:

- **Declared** — represented in a contract or schema.
- **Implemented** — concrete behavior exists.
- **Composed** — the production launcher reaches it.
- **Verified** — production-path tests and manual checks pass.
- **Cutover-ready** — real-host conformance, security gates, rollback, and packaging all pass.

Only the last state permits Pi removal.
