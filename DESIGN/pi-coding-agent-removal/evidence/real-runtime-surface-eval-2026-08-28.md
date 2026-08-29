# Real runtime surface evaluation — 2026-08-28

Candidate: dirty working tree on macOS, Node 26.4.0. This is implementation
evidence, not a release/canary approval.

## Result

| Surface | Result | Real sensor | Remaining gate |
|---|---|---|---|
| Multi-process recovery | PASS | Production supervision persisted PID, OS start identity, command hash, and ownership-token hash. A real RPC child survived simulated parent loss, restart recovery revalidated it before TERM/KILL, and the test proved PID disappearance and one terminal receipt. PID-reuse/mismatched identities were never signalled. | Clean-candidate soak and cross-platform identity matrix. |
| Editor/RPC worker projection | PASS for JSONL RPC | Strict `projection: "worker"` commands and ordinary runtime requests shared the production backpressure-safe writer. Projection is bound to the active session/prompt/capability ceiling; mutations require trusted-workspace, on-request process approval. Duplicate request IDs remain distinguishable. | ACP-specific worker projection remains separate future conformance work. |
| Provider breadth | PASS for adapter/configuration; SKIP for live Anthropic | Built CLI reported Anthropic Messages and its canonical endpoint; OpenAI Chat Completions, OpenAI Responses, and Anthropic adapter suites passed. Capability-gated Anthropic smoke returned `SKIP(credentials-absent)`. | Credentialed real-provider matrix and soak. |
| Hooks/plugins | PASS for discovery, trust, command execution, activation, and lifecycle projection | Contained filesystem discovery, real command child execution, matcher/authority/rewrite/deny/cancellation receipts, and transactional plugin activation passed. A real plugin fixture proved unreviewed denial, exact-hash review plus complete grants, contribution reachability, and cleanup after normal and failed construction. | Settings UI for review/grant management; MCP and async hook executors. Missing policy grants nothing. |
| Settings UX | PASS on local server | The real loopback page was opened in the in-app browser, keyboard focus and ARIA state were inspected, a model setting was saved, and a 390×844 viewport had no horizontal overflow. The temporary server and tab were closed. | Cross-browser/platform matrix and remaining configuration panels. |
| PTY/accessibility | PASS on this host | Production OpenTUI rendered semantic role/status text inside a real pseudo-terminal and restored the exact `stty -g` state, printing `OCTOCODE_PTY_RESTORED`. | Node 26 requires `NODE_OPTIONS=--experimental-ffi`; other supported terminals/platforms remain untested. |

## Guardrails

- Permission bypass: no observed bypass; unreviewed extensions remain
  non-executable, and worker RPC mutation fails closed without trusted approval.
- Protocol contamination: worker and ordinary RPC envelopes coexist with strict,
  closed parsing and correlated responses.
- Process leaks: built worker EOF/open-handle and escalation cases passed.
- Terminal restoration: exact before/after terminal mode matched.
- Provider evidence: missing credentials are recorded as `SKIP`, never `PASS`.

## Verification commands and receipts

- `yarn workspace octocode-agent typecheck` — PASS.
- `yarn workspace octocode-agent build` — PASS; rebuilt
  `out/octocode-agent.mjs`.
- `yarn workspace octocode-agent test` — PASS: 60 files passed, one skipped;
  489 tests passed, 16 skipped.
- `yarn lint && yarn typecheck && yarn test` — PASS across the monorepo: 320
  test files passed, one skipped; 3,407 tests passed and 16 skipped.
- Adversarial worker/RPC/extensions/settings/provider/terminal selection — PASS:
  11 files, 79 tests.
- Real PTY smoke with experimental FFI — PASS and exact restoration marker.
- Built `models --json` with `OCTOCODE_MODEL_PROTOCOL=anthropic-messages` — PASS.
- Anthropic capability smoke without credentials — `SKIP(credentials-absent)`.

The canonical release decision remains HOLD. These receipts close dirty-tree
implementation gaps only; they do not close clean-build, provider-credential,
cross-editor, cross-platform, canary, or Pi-retirement gates.

An independent post-fix audit reported no remaining P0/P1/P2 findings and
separately confirmed approval/session binding, PID-reuse refusal, plugin cleanup,
response discrimination, honest PTY scope, and no surviving worker process.

## Architecture hardening increment

The later 2026-08-28 architecture pass used the executable architecture and Pi
parity prompts, AST discovery, LSP reference checks, focused tests, and built
runtime probes. The release verdict remains `HOLD`.

| Gate | Result | Production evidence | Remaining work |
|---|---|---|---|
| Durable compaction and restart | Partial | Built RPC `context.compact` returned `chat-ok`; the same durable session resumed successfully. Core tests cover retry, unknown retained IDs, interrupted-attempt recovery, and projection replay. | Automatic threshold and overflow triggers, abrupt-process crash corpus, and cross-process stress. |
| Runtime retry and effect ledger | Pass for the composed native path | Safe provider failures retry only before an effect starts. Native effect admission and terminal states persist as session events and reject reconstruction replay. | Credentialed provider rate-limit matrix and clean-candidate multi-process stress. |
| Non-cooperative tool supervision | Pass with an explicit uncertainty boundary | Cancellation returns within the bound, emits one terminal event, suppresses late updates, and records the detached in-process effect as `uncertain`. | Prefer isolated process execution for effects that require provable termination. |
| Tool JSON Schema validation | Partial | Combinators, local references, conditional branches, object, array, string, and numeric constraints pass focused tests for input and output. | Remote references, formats, and the complete draft compatibility corpus. |
| Effective model catalog | Pass | Canonical, persisted, and environment sources compose through core `ModelCatalog`; runtime validation uses the effective result. | Credentialed capability refresh/import matrix. |
| Canonical settings writers | Pass | `config set` uses typed service mutations; `models --set` commits provider and model atomically and preserves unknown values. | Remaining settings panels and recovery/import/export. |
| Print, JSON, RPC, and ACP signals | Pass | Focused lifecycle tests pass; a built RPC `SIGTERM` probe exited 143 with `ready → stopping → stopped`. | Reproduce on every supported platform and close the bootstrap-window risk. |
| ACP timeout semantics | Pass | Runtime timeout maps to ACP `max_turn_requests`; close owns active prompt cancellation and bounded cleanup. | Independent editor-client conformance matrix. |
| Real Pi/native conformance | Partial and release-blocking | Production adapters invoke the Pi extension and native launcher. The bounded ledger executes 1 of 14 scenarios and reports a registry divergence; 13 scenarios report explicit unsupported reasons. | Implement the remaining production scenarios and resolve every classified divergence. |

### Ratings

| Area | Score | Basis |
|---|---:|---|
| RFC and architecture specification | 9.1/10 | Strong ownership, invariants, stop gates, and traceability; release inputs and some ADRs remain deferred. |
| Agent core | 9.0/10 | Strict lifecycle, retry, schema, effect, and durable compaction services with 91 passing tests. |
| Native settings and model control | 9.2/10 | One service and effective catalog own reads, validation, and atomic writes. |
| Signals and ACP lifecycle | 9.3/10 | Exact-once ownership, bounded cleanup, truthful timeout mapping, and real signal evidence. |
| Sessions and compaction | 8.3/10 | Durable manual path and restart recovery pass; automatic triggers and crash matrix remain. |
| OpenTUI UI and widgets | 8.8/10 | Broad widget and PTY coverage on this host; supported-platform and accessibility release matrices remain. |
| Real-host parity evidence | 5.5/10 | The harness is now honest and production-runnable, but the measured product parity result is still mostly unsupported. |
| Integrated implementation | 8.7/10 | Six of the nine bounded architecture gates are complete; three are partial. |
| Release readiness | 6.8/10 | Clean candidate, real parity, credentials, platforms, canary, and rollback gates remain open. |

### Verification receipt

- Agent core: 8 files and 91 tests passed; typecheck and build passed.
- Native agent: 61 files passed, one skipped; 505 tests passed and 16 skipped
  after the durable-ledger test was added; typecheck and build passed.
- Production host conformance: 18 focused tests passed; the result remains
  `HOLD`, not skipped success.
- Root lint, typecheck, and build passed. The first parallel root-test attempt
  raced package builds; the ordered rerun passed core, testing, and Awareness,
  then exposed a stale shared ownership test when `src/utils.ts` was removed.
  Restoring that contract file fixed the focused shared suite. The final ordered
  root rerun is the canonical test receipt: 322 test files passed, one file was
  intentionally skipped, 3,432 tests passed, and 16 tests were skipped.
