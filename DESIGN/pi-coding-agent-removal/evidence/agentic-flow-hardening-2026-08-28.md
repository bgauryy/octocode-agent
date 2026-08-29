# Agentic flow hardening — 2026-08-28

Status: **ACCEPTED dirty-tree increment; release remains HOLD**

## Goal

Harden the native model-and-tool loop, MCP and Skill discovery, session replay,
and headless execution against duplicate effects, ambiguous failures, unbounded
data, cross-workspace cache leakage, and interrupted turns.

## KPI

- Primary: every reproduced agent-loop defect has a failing regression test and
  a passing implementation result. Result: 12 defect classes fixed and covered.
- Leading: focused suites pass before the full workspace suite. Result: agent
  core 31/31, native agent 51/51, and shared Skill discovery 6/6.
- Guardrails: no excess tool side effect, no credential or provider-body leak,
  no MCP working-directory escape, no orphan tool-call replay, and no partial
  cancelled assistant text in durable history.
- Decision rule: accept the increment only if build, lint, typecheck, root tests,
  the OpenTUI FFI suite, and a built headless command all pass.

## Subject changed

- `packages/octocode-agent-core/src/runtime/kernel.ts` now keeps model identity
  stable during a turn, correlates events with turn and model identity, accounts
  for cached input tokens, classifies provider stops and translation failures,
  bounds tool-call count and result size, and persists terminal events before
  notifying presentation subscribers.
- `packages/octocode-agent/src/native-model.ts` normalizes HTTP and network
  failures, parses `Retry-After`, redacts response bodies, and maps midstream
  interruptions to cancellation.
- `packages/octocode-agent/src/native-launcher.ts` validates native model and
  thinking capabilities, scopes MCP approval text, drops cancelled partial
  assistant text, and repairs interrupted assistant tool calls with synthetic
  cancelled tool results on resume.
- `packages/octocode-agent/src/native-mcp.ts` resolves real paths for stdio
  working directories and follows bounded resource and prompt pagination.
- `packages/octocode-agent/src/native-tools.ts` isolates the Octocode catalog
  cache by runner, workspace, and relevant environment.
- `packages/octocode-shared/src/agent-skills.ts` continues discovery after a
  symlink candidate instead of hiding later valid Skills.

## Harness and loop level

This was an experiment-level TDD loop. Each defect was first expressed as a
focused failing test, then fixed without changing the test expectation. The
final sensor was the built `octocode-agent` command against a local synthetic
OpenAI-compatible SSE server. The fixture used no production credentials and
performed no external effects.

## Checks run

| Check | Observed result |
|---|---|
| Agent-core runtime loop | 1 file, 31 tests passed |
| Native model, launcher, MCP, capabilities, and tools | 5 files, 51 tests passed |
| Shared Skill discovery | 1 file, 6 tests passed |
| Root build | Passed |
| Root lint | Passed |
| Root typecheck | Passed |
| Root tests | 296 files passed, 1 skipped; 3,220 tests passed, 15 intentional native non-FFI tests skipped |
| OpenTUI native FFI renderer | 1 file, 15 tests passed |
| Built headless command with synthetic SSE provider | Exit 0; exact standard output `smoke-ok`; no standard error |
| Octocode AST and LSP proof | Runtime failure sites were enumerated structurally; replay repair and scoped approval have production references. The TypeScript server exposes push rather than pull diagnostics, so root typecheck is the diagnostic receipt. |

## Verdict

**ACCEPT.** The changes fix the reproduced failures, the bounded loop prevents an
excess model tool batch before side effects, and the full local verification
stack passes. This advances the dirty-tree implementation candidate only.

## Open work

Release remains **HOLD**. The native runtime still needs a dedicated OpenAI
Responses adapter with lossless reasoning and tool-call correlation, an owned
retry and idempotency policy, context-window compaction, MCP 2026 conformance
including durable tasks and list-change/cache semantics, a stale session-writer
lease policy, and the clean provider/platform/packaging/canary/rollback corpus.
