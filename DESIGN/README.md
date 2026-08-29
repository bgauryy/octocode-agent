# Pi coding-agent removal — implementation guide

Status: active design index; reconciled 2026-08-28; release remains `HOLD`

This directory is the main guide for completing the native Octocode agent and removing Pi. The RFC folder is normative. The root documents explain the implementation, architecture, execution order, and current maturity without duplicating specialist specifications.

Start with the [RFC overview](pi-coding-agent-removal/README.md), then use the documents below for implementation work.

## Document map

| Need | Document | Authority |
| --- | --- | --- |
| Current implementation snapshot | [Current-state audit](01-CURRENT-STATE-AUDIT.md) | Dated summary; does not override live ledgers |
| Runtime, providers, tools, and policy | [Agent runtime and tools](02-AGENT-RUNTIME-AND-TOOLS.md) | Implementation guide |
| Durable sessions and compaction | [Sessions and compaction](03-SESSIONS-AND-COMPACTION.md) | Implementation guide |
| Terminal and settings composition | [TUI and settings](04-TUI-AND-SETTINGS.md) | Implementation guide and route map |
| Security, conformance, and operations | [Conformance, security, and operations](06-CONFORMANCE-SECURITY-AND-OPERATIONS.md) | Implementation guide |
| Dependency-safe execution order | [Implementation sequence](07-IMPLEMENTATION-SEQUENCE.md) | Root execution guide |
| Requirement maturity | [Traceability ledger](08-TRACEABILITY-CHECKLIST.md) | Live implementation ledger |
| Package boundaries and flows | [Architecture and flow](09-ARCHITECTURE-AND-FLOW.md) | Root architecture guide |
| Work still required | [Remaining-work plan](10-REMAINING-WORK-PLAN.md) | Live work-group index |
| Widget classes and accessibility | [OpenTUI widgets and accessibility](11-OPENTUI-WIDGETS-AND-ACCESSIBILITY.md) | Implementation guide |
| Product scope, schemas, gates, and evidence | [Pi coding-agent removal RFC](pi-coding-agent-removal/README.md) | Normative source |

The hooks and plugins specification lives only in [the RFC specialist document](pi-coding-agent-removal/HOOKS_AND_PLUGINS.md). The OpenTUI core and settings specifications likewise live in [OpenTUI terminal core](pi-coding-agent-removal/OPENTUI_TERMINAL_CORE.md) and [settings web UI](pi-coding-agent-removal/SETTINGS_WEB_UI.md). Root guides link to those owners instead of restating them.

## Authority and update rules

| Information | Canonical owner |
| --- | --- |
| Product decisions, accepted schemas, compatibility, and release gates | RFC specialist documents |
| Current release state and blockers | [RFC status](pi-coding-agent-removal/STATUS.md) |
| Step order and stop conditions | [RFC steps](pi-coding-agent-removal/STEPS.md) |
| Requirement maturity | [Traceability ledger](08-TRACEABILITY-CHECKLIST.md) |
| Dependency-grouped remaining work | [Remaining-work plan](10-REMAINING-WORK-PLAN.md) |
| Dated command output and evaluations | `pi-coding-agent-removal/evidence/` |

Historical evidence receipts are immutable. Correct current documents rather than rewriting an old receipt. When two active documents conflict, keep the release at `HOLD`, update the owning RFC document first, and then reconcile its implementation guide and live ledger.

## Completion rule

A requirement advances to `Verified` only when the production native composition reaches it and focused plus production-path checks pass. `Cutover-ready` additionally requires real-host, security, platform, packaging, rollout, and rollback evidence.

Pi removal is the final consequence of those gates. It must not be used to manufacture parity. Generated output and `.octocode/` state are never documentation sources and must not be hand-edited.
