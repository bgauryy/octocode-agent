# Pi Coding Agent Removal — Completion Design

Status: canonical implementation guide; implementation required  
Source RFC: [`pi-coding-agent-removal/RFC.md`](pi-coding-agent-removal/RFC.md)  
Execution plan: [`pi-coding-agent-removal/STEPS.md`](pi-coding-agent-removal/STEPS.md)  
Complete RFC and evidence set: [`pi-coding-agent-removal/`](pi-coding-agent-removal/README.md)

This directory is the canonical implementation guide for the Pi coding-agent removal. It combines the original RFC, planning, and evidence set with the implementation-facing completion design produced from the current production-path audit. Start here rather than entering through an individual RFC document.

The native cutover is blocked until every required behavior is implemented, exercised through a real host path, and checked off in the traceability matrix. Pi removal must be the final consequence of conformance, never the mechanism used to force it.

## Documents

1. [`01-CURRENT-STATE-AUDIT.md`](01-CURRENT-STATE-AUDIT.md) — release-blocking findings and verified positive controls.
2. [`02-AGENT-RUNTIME-AND-TOOLS.md`](02-AGENT-RUNTIME-AND-TOOLS.md) — agent loop, models, tools, policy, cancellation, and transports.
3. [`03-SESSIONS-AND-COMPACTION.md`](03-SESSIONS-AND-COMPACTION.md) — durable sessions, resume, branching, migration, and compaction.
4. [`04-TUI-AND-SETTINGS.md`](04-TUI-AND-SETTINGS.md) — OpenTUI interaction and the unified settings control plane.
5. [`05-HOOKS-AND-PLUGINS.md`](05-HOOKS-AND-PLUGINS.md) — executable hooks, trust, plugin grants, contributions, and unload.
6. [`06-CONFORMANCE-SECURITY-AND-OPERATIONS.md`](06-CONFORMANCE-SECURITY-AND-OPERATIONS.md) — real-host comparison, zero-bypass security, observability, and rollback.
7. [`07-IMPLEMENTATION-SEQUENCE.md`](07-IMPLEMENTATION-SEQUENCE.md) — dependency-safe delivery order and cutover gates.
8. [`08-TRACEABILITY-CHECKLIST.md`](08-TRACEABILITY-CHECKLIST.md) — one completion ledger for every audited leftover.
9. [`pi-coding-agent-removal/`](pi-coding-agent-removal/README.md) — the complete source RFC, schemas, stages, test plan, status, decisions, and evidence archive.

## How to use this guide

1. Read the current-state audit and the target design for the area being changed.
2. Consult the source RFC folder for normative schemas, stage definitions, historical decisions, and evidence.
3. Implement in the order defined by `07-IMPLEMENTATION-SEQUENCE.md`.
4. Close the corresponding `08-TRACEABILITY-CHECKLIST.md` item only after production composition and verification.
5. Update the RFC status/evidence documents without weakening the cutover or rollback gates.

## Completion rule

A checkbox may be closed only when all four conditions hold:

1. The behavior is reachable through the production native launcher.
2. A test exercises that production composition, not only an isolated class or fake handler.
3. The relevant package is rebuilt and its workspace tests, lint, and typecheck pass.
4. A real CLI, RPC, PTY, provider, or migration path demonstrates the behavior as applicable.

No compatibility shim is required unless explicitly requested. Generated output and `.octocode/` state must not be hand-edited.
