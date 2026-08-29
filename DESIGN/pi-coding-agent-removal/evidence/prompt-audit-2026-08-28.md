# Native CLI prompt-audit receipt

Date: 2026-08-28  
Tree: dirty working-tree candidate based on `69b5cb76711d32102a091605ee40b774ec342886`  
Decision: **HOLD — do not remove Pi or start a canary**

## Scope

Three independent specialists executed every prompt in the repository `prompts/`
directory, sequentially:

1. `architecture.md`
2. `cli-context-efficiency.md`
3. `pi-feature-parity.md`

The orchestrator verified each change, resolved integration failures, and ran the
repository checks. The audits used Octocode local search, structural search, and
LSP reachability. The task did not authorize or perform live-provider spend,
release mutation, credential use, or Pi deletion.

## Integrated corrections

| Area | Proven defect | Correction and focused evidence |
|---|---|---|
| RPC control | The RPC input loop awaited an active submit, so cancel, steer, and follow-up did not run concurrently. | Dispatch requests concurrently, preserve request correlation, and join in-flight dispatches before stop; transport suite passes. |
| Headless exit | Print and JSON modes returned success after `runtime.failed` or a turn ending with `stop: "error"`. | Derive the exit code from terminal runtime events while remaining subscribed through stop; transport suite passes 8/8. |
| Provider stream | Out-of-order Chat Completions chunks finalized tool calls in arrival order instead of provider index order. | Sort finalized calls by numeric provider index; focused provider suites pass 12/12. |
| Shared plan identity | Pi omitted its source kind when projecting an accepted plan, allowing retry to materialize a different graph and bypass compensation. | Project with `sourceKind: "pi"`; the focused plan suite passes 26/26. |
| Command discovery | Native `/thinking` existed but was missing from `/help`. | Add the conditional-support help entry; the slash-command suite passes 4/4. |
| Awareness help | Public `next`, `inspect`, `verify`, and `close` aliases lost their identity in focused help; `verify audit` resolved to `verify mark` help. | Preserve alias and action route keys with explicit schema-bearing help; focused CLI suites pass 30/30. |

## Exhaustive feature result

The parity audit classified every stable feature ID in
`READINESS_AND_FEATURE_MATRIX.md`: 100 of 100 rows across R12, T12, S10, H14,
P19, U15, A8, and Q10.

| Dimension | Result |
|---|---|
| Maturity | 20 verified, 14 composed, 48 implemented, 18 declared, 0 cutover-ready |
| Parity | 4 approved differences, 1 native superset, 13 unproven, 23 partial, 2 mismatches, 55 missing, 2 holds, 0 proven matches |

The two direct mismatches are provider/protocol coverage (`R-09`) and command
system parity (`T-03`). The most important missing proof is `Q-03`: the canonical
14-scenario conformance harness runs synthetic handlers rather than the real Pi
0.84.2 and native production hosts. Identical synthetic handlers cannot establish
cross-host parity.

## Verification

The integrated working tree produced these receipts:

- `yarn build`: passed.
- `yarn lint`: passed.
- `yarn typecheck`: passed.
- `yarn workspace octocode-agent test`: 322 passed, 15 intentionally skipped
  without the native FFI flag.
- Native OpenTUI FFI package path: 337 passed.
- Pi extension: 1,766 passed after the shared-plan identity correction.
- Agent core: 46 passed.
- Agent testing: 27 passed.
- Focused Awareness help routes: 30 passed.
- Final `yarn test`: 3,177 passed and 15 intentionally skipped across agent core,
  agent testing, Awareness, shared, native agent, and Pi extension workspaces.

Historical dirty-tree receipts remain non-canonical.

## Release gates

The audits proved that these items are not locally closable by more unit tests or
documentation alone:

- select a clean canonical baseline and freeze an immutable Pi oracle;
- connect the 14 conformance scenarios to real Pi and native production adapters;
- approve provider retention or retirement, then run credentialed protocol and
  usage matrices;
- compose native hooks, plugins, orchestration, settings, migration selection,
  shadow comparison, and the remaining session operations;
- approve storage, plugin trust, hook-fixture, OpenTUI platform, and release
  policies;
- run packed install/upgrade, platform, security, canary, observation, and
  native-only rollback receipts; and
- prove final repository and artifact absence before deleting Pi.

Until those gates have commit-addressed evidence and the required independent
approvals, the only valid release decision is **HOLD**.
