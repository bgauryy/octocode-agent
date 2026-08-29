# Headless runtime evaluation — 2026-08-28

Status: **ACCEPTED dirty-tree increment; release remains HOLD**

## Goal

Run the governed native Octocode agent through the built command in text, JSON,
RPC, piped-input, and tool-loop scenarios without OpenTUI initialization.

## KPI

- Primary: deterministic headless scenarios passed. Baseline: transport-only
  tests passed, but no built-command corpus proved the shared agent prompt or a
  model-to-tool loop. Result: 5/5 command scenarios passed. Target: 5/5.
- Leading: Octocode catalog process launches per runtime startup. Baseline: one
  lean catalog call plus one schema call per catalog tool, about 16 processes for
  the 15-tool catalog. Result: one `tools --json --full` process. Target: one.
- Guardrails: focused tests, typecheck, build, lint, full repository tests,
  protocol-only standard output, bounded model/tool iterations, policy gates,
  and MCP/skill containment must remain green.
- Decision rule: accept only when all five built-command scenarios pass and all
  guardrails remain green.

## Subject changed

- `packages/octocode-agent/src/native-prompt.ts` composes the shared Octocode
  policy, Awareness policy, and hierarchical repository instructions.
- `packages/octocode-agent/src/native-launcher.ts` places the stable system prefix
  before session history, supports piped prompts, and rejects empty terminal runs
  before runtime creation.
- `packages/octocode-agent/src/native-tools.ts` loads the full schema catalog in
  one process, sorts it, caches the in-flight result, and executes commands in the
  selected workspace and environment.
- `packages/octocode-agent/src/native-mcp.ts` follows paginated tool catalogs,
  sorts them, and reuses a bounded per-runtime catalog cache.
- `packages/octocode-agent/src/native-skills.ts` reads bounded supporting text
  files with realpath containment. It does not execute scripts or grant tools.
- `packages/octocode-agent/src/native-model.ts` exposes provider-reported cached
  input tokens in usage events.

## Harness

The test and command harness stayed fixed after the implementation change. The
local HTTP fixture returned OpenAI-compatible SSE frames and recorded only
request shape: endpoint, first-message role, tool count, and correlated tool
results. It contained no production credentials or external effects.

## Loop level

Experiment. This evaluation exercises the built native headless runtime through
its public command surface and records observable envelopes and provider
requests; it is broader than a unit test but narrower than a production canary.

## Budget and trials

One failing baseline and one implementation iteration were used. The final
built-command evaluation covered five scenarios: text output, JSON envelopes,
piped stdin, RPC serving, and a two-iteration skill-tool loop.

## Checks run

| Check | Observed result |
|---|---|
| Focused native prompt, launcher, model, tool, MCP, and skill tests | 6 files, 44 tests passed |
| Agent-core and native-agent typecheck | Passed |
| Shared, agent-core, and native-agent builds | Passed |
| Root build, lint, typecheck, and test suite | Passed; 3,196 tests passed and 15 intentional native non-FFI cases skipped |
| Built `run` with argument input | Exit 0; output `headless-ok` |
| Built `run --json` | Exit 0; nine valid version-1 event envelopes; usage included four cached input tokens |
| Built `run` with piped input | Exit 0; output `headless-ok` |
| Built `serve` RPC snapshot | Exit 0; correlated `snapshot-1` response plus ordered lifecycle events |
| Built two-iteration skill loop | Exit 0; output `tool-loop-ok`; second provider request contained one correlated tool result |
| Provider request inspection | The final built request contained the shared Octocode authority, Awareness guidance, root `AGENTS.md`, and 19 published tools |
| Octocode AST proof | System-message composition, bounded MCP pagination, and skill realpath containment found in production source |
| Octocode LSP proof | Changed symbols are production-reachable; pull diagnostics were unavailable because the TypeScript server uses push diagnostics, so typecheck is the diagnostic anchor |

## Verdict

**ACCEPT.** The primary moved from an unproved command path to 5/5 passing
headless scenarios, catalog startup reached the one-process target, and the
focused guardrails passed. The full-suite results are recorded in `STATUS.md`
after the final repository checks complete.

## Limitations

This increment does not close the release gate. Later dirty-tree increments add
Responses and Anthropic adapters, durable manual compaction, settings control,
and ACP; the integrated receipt links those results. Persistent MCP connections
and list-change notifications, MCP durable tasks, deferred model-visible tool
discovery, automatic context budgets, and compaction triggers, writable coding
tools, the complete trust UI, real Pi/native parity, and the clean
multi-platform release corpus remain open.
