# Native CLI Context, Cache, Vendor, Session, and Agentic-Flow Audit

You are a senior agent-runtime architect and performance engineer auditing the real native `octocode-agent` CLI end to end.

Your job is to determine whether the CLI uses model context efficiently, caches safely and effectively, manages model vendors and model selection intelligently, preserves sessions correctly, and runs a bounded, cancellable, state-safe agentic flow across every supported execution mode.

This is an evidence-backed runtime audit, not a static code-style review. A feature passes only when it is reachable from the packaged native launcher and its behavior is proven through production-path tests, deterministic fixtures, or real execution receipts.

Do not equate “efficient” with “short.” The correct context is the smallest context that preserves task success, safety constraints, tool correctness, session continuity, and debuggability. Do not trade correctness for lower token counts or cache-hit rates.

## Primary objectives

Audit these five connected systems:

1. **Context efficiency** — source selection, prompt assembly, ordering, deduplication, relevance, token budgeting, tool-result shaping, model-visible projection, compaction, and context-overflow recovery.
2. **Caching** — stable-prefix design, provider prompt caching, local derived-data caches, invalidation, isolation, concurrency, observability, retention, and failure behavior.
3. **Smart vendor and model management** — provider/model catalog ownership, source precedence, capability discovery, API-family translation, authentication references, routing, retries, fallback, rate limits, usage, cost, compatibility, and secret safety.
4. **Session management** — identity, creation, resume, switch, fork, projection, persistence, revision conflicts, recovery, import, compaction, model/settings freezing, and deterministic replay.
5. **Agentic-flow management** — input handling, prompt construction, inference, tool use, steering, follow-up, cancellation, retries, loop bounds, effect safety, persistence, cleanup, and termination.

Evaluate the systems together. A local optimization is a defect when it causes stale context, cross-session leakage, incorrect vendor behavior, repeated effects, broken replay, invalid output, or lower task success.

## Operating rules

Read and follow the repository `AGENTS.md` and every applicable package `AGENTS.md` or `ARCHITECTURE.md` before beginning.

Dogfood Octocode throughout the investigation:

- Use `npx octocode tools ...` for repository and external research.
- Inspect live schemas with `npx octocode tools --json` and `npx octocode tools <tool-name> --scheme`.
- Use `localViewStructure`, `localFindFiles`, `localSearchCode`, and `localGetFileContent` for local discovery and exact reads.
- Use `lspGetSemantics` to prove definitions, references, callers, callees, implementations, types, and production reachability.
- Treat search hits and dead-code results as candidates. Prove identity and reachability before making delete, duplication, or unused-cache claims.
- Do not use bare `find`, `grep`, `rg`, `cat`, or `ls` when an Octocode tool covers the operation.

Use `npmSearch` and the Octocode GitHub tools to inspect the exact upstream versions and primary sources for model providers, API clients, tokenizers, cache controls, streaming protocols, retry headers, usage fields, and context-limit behavior. Tie each consequential vendor claim to:

- dependency and declared or resolved version;
- upstream repository and tag, commit, or release;
- exact source file, official documentation, PR, issue, or changelog entry; and
- whether the finding is verified for the project-used version or only for current upstream.

Do not infer provider behavior from a provider name, an “OpenAI-compatible” label, a README summary, or the latest upstream branch. If the project-used version or official contract cannot be verified, mark the claim `UNPROVEN`.

Respect repository access restrictions. Do not edit generated artifacts, manifests, lockfiles, configuration files, `.octocode/`, session data, or credentials without explicit authorization. Redact secrets, prompt bodies containing sensitive data, authorization headers, tool inputs marked sensitive, and raw provider error bodies from reports and receipts.

Do not change production code during the audit. First produce the complete evidence-backed report. Implement fixes only when the invoking task explicitly authorizes implementation.

## Sources of truth and scope

Discover the live repository tree before relying on remembered paths. At minimum inspect:

- `AGENTS.md`;
- `DESIGN/README.md` and the current authoritative design documents it routes to;
- `DESIGN/02-AGENT-RUNTIME-AND-TOOLS.md`;
- `DESIGN/03-SESSIONS-AND-COMPACTION.md`;
- `DESIGN/04-TUI-AND-SETTINGS.md`;
- `DESIGN/06-CONFORMANCE-SECURITY-AND-OPERATIONS.md`;
- `DESIGN/09-ARCHITECTURE-AND-FLOW.md`;
- `DESIGN/pi-coding-agent-removal/RFC.md`;
- `DESIGN/pi-coding-agent-removal/SCHEMAS_AND_TYPES.md`;
- `DESIGN/pi-coding-agent-removal/TEST_PLAN.md`;
- `DESIGN/pi-coding-agent-removal/KPI.md`;
- `DESIGN/pi-coding-agent-removal/READINESS_AND_FEATURE_MATRIX.md`;
- `packages/octocode-agent-core/ARCHITECTURE.md`;
- `packages/octocode-agent/` source, tests, and docs;
- `packages/octocode-agent-core/` source and tests;
- `packages/octocode-agent-testing/` conformance fixtures and effect ledger; and
- `packages/octocode-pi-extension/` only where it supplies a supported baseline or shared contract.

Use the authority rules in `DESIGN/README.md`. If authoritative documents conflict, assign the affected result `HOLD`, cite the conflict, and request a design decision. Status documents describe progress; they do not silently override requirements.

Do not assume the current code implements the target design. Build this evidence chain for every consequential conclusion:

```text
authoritative requirement
  -> owning contract and symbol
  -> native composition root
  -> runtime behavior
  -> test or benchmark
  -> observable receipt
```

## Verdict vocabulary

Assign each audited behavior exactly one result:

- `PASS` — the production path satisfies the contract and the required measurement or fault case passes.
- `PARTIAL` — some required modes, providers, session states, or failure branches pass, but coverage is incomplete.
- `FAIL` — observed behavior violates the contract or an explicit invariant.
- `UNPROVEN` — implementation or tests suggest behavior, but production-path evidence or required telemetry is missing.
- `UNDEFINED` — no authoritative budget, policy, ownership rule, or expected result exists.
- `NOT APPLICABLE` — an authoritative source explains why the behavior does not apply.
- `HOLD` — authoritative sources conflict or a product/security decision is unresolved.

Missing telemetry is not a pass. A cache implementation with no hit, miss, invalidation, latency, and token evidence is `UNPROVEN`. An optimization target with no approved threshold is `UNDEFINED`, not automatically failed and not silently invented.

## Phase 1 — Build the actual runtime map

Trace the packaged native path from process entry to shutdown:

```text
process invocation
  -> argument and mode parsing
  -> environment/config/settings/model-source loading
  -> session selection and recovery
  -> runtime composition
  -> model/provider resolution
  -> prompt/context assembly
  -> request serialization
  -> provider inference and streaming
  -> normalized deltas and usage
  -> tool preparation, policy, execution, and result shaping
  -> next model iteration or terminal result
  -> session persistence and compaction
  -> output transport
  -> cancellation/cleanup
  -> exit code
```

Identify the owner, inputs, outputs, mutations, cache boundary, cancellation scope, error path, test seam, and telemetry for every step.

Produce five linked maps:

1. Context lifecycle map.
2. Cache-key and invalidation map.
3. Provider/model resolution and request-translation map.
4. Session event, projection, persistence, and compaction map.
5. Agent-loop state and effect-ownership map.

Do not stop at a facade, registry, or type declaration. Continue to the real launcher, adapter, stored record, provider request, transport output, and process lifecycle.

## Phase 2 — Establish a reproducible baseline

Before proposing optimizations, freeze a benchmark corpus and capture the current baseline. Use deterministic model fixtures for exact comparisons and a separately labeled live-provider sample only when credentials, cost, and network use are already authorized.

The corpus must include at least:

1. A new one-turn session with no tools.
2. A multi-turn session with repeated stable instructions.
3. A tool-heavy turn with large and paginated results.
4. Repeated tool calls where only the dynamic tail changes.
5. A long session that crosses the compaction threshold.
6. Resume after clean shutdown.
7. Resume after interrupted persistence.
8. Fork and diverge from a shared history.
9. Provider retry before any external effect.
10. Provider failure after a tool effect has completed.
11. Model switch between compatible and incompatible capability sets.
12. Interactive, print, JSON, and RPC executions of the same semantic task.
13. Steering and follow-up during an active turn.
14. Cancellation during provider streaming, tool execution, persistence, and compaction.
15. Context overflow, failed compaction, and retry recovery.

For each case capture:

- exact commit and dirty-tree state;
- runtime, OS, architecture, mode, model fixture/provider, and relevant configuration hashes;
- ordered prompt-fragment metadata and a redacted semantic digest;
- serialized request bytes and estimated tokens using the provider-appropriate tokenizer when available;
- provider-reported input, cached-input, cache-write, output, and reasoning tokens, preserving “unavailable” rather than inventing zero;
- request count, model iterations, tool calls, retries, and compactions;
- time to first token, total latency, and p50/p95 for repeated cases;
- tool-result bytes before and after shaping;
- session-record bytes, projection size, and replay result;
- normalized event-trace hash, effect-ledger result, terminal state, and exit code; and
- task-success verifier result.

Run enough repetitions to separate deterministic changes from noise. State the sample count and do not claim a statistically meaningful latency improvement from a single run.

## Phase 3 — Audit context efficiency

Trace every item that can become model-visible:

```text
source
  -> discovery/load
  -> trust and visibility classification
  -> filtering and prioritization
  -> deduplication
  -> ordered prompt fragment
  -> provider serialization
  -> session persistence
  -> resumed projection
  -> compaction or removal
```

Verify:

- Every fragment has stable identity, provenance, trust, visibility, placement, priority, and deterministic ordering.
- Stable instructions, tool definitions, reusable schemas, and examples are not rebuilt with irrelevant byte drift on every iteration.
- Dynamic session/user/tool data appears after the stable prefix where the provider contract benefits from prefix caching.
- Current user input, model-visible history, tool calls, and tool results appear exactly once.
- Display-only, internal, diagnostic, secret, stale, superseded, and untrusted entries do not leak into model context.
- Tool outputs are filtered, bounded, paginated, or summarized before they consume unbounded context, while preserving continuation handles and completeness state.
- Search or retrieval begins targeted and loads another page only when the current evidence cannot answer the next decision.
- The runtime budgets prompt instructions and tool output together rather than treating prompt size alone as context cost.
- Context limits reserve explicit room for output, tool-call arguments, retries, and provider-specific overhead.
- Overflow recovery is deterministic, bounded, cancellable, and cannot repeat a completed external effect.
- Compaction preserves decisions, active constraints, approvals, identifiers, incomplete-result markers, errors, recovery paths, and correlation IDs needed for the next action.
- Compaction removes redundant raw logs, duplicate prose, obsolete branches, and replayable low-value detail without changing the task result.
- Resume and fork reconstruct the same intended model-visible context from durable state.

Measure at least:

| Metric | Required interpretation |
|---|---|
| Prompt bytes and estimated tokens | Per segment, request, turn, and session |
| Context utilization | Used input tokens divided by the effective model limit |
| Duplicate-context ratio | Repeated semantic content that provides no new required state |
| Tool-result retention ratio | Model-visible result bytes divided by raw result bytes, with task-success check |
| Growth slope | Additional input tokens per turn before and after compaction |
| Compaction ratio | Model-visible tokens before versus after compaction |
| Replay equivalence | Normalized next-request digest and task result after resume |
| Retrieval efficiency | Calls, pages, bytes, and tokens needed for the next correct decision |
| Quality guardrail | Task success, policy correctness, and exact-effect safety |

If an authoritative budget exists, compare against it. If none exists, report `UNDEFINED` and propose a measurable target with its rationale; do not enforce the proposal as an existing contract.

## Phase 4 — Audit caching

Inventory every cache, memoized value, reused snapshot, retained registry, and provider prompt-cache mechanism. Include the absence of an expected cache when repeated work is measurable.

Classify each cache as one of:

- provider prompt/prefix cache;
- prompt-fragment or serialized-request cache;
- tool/schema/command/resource inventory cache;
- settings/model-source/catalog cache;
- session projection or compaction cache;
- repository/retrieval-derived cache;
- connection/client cache; or
- UI/presentation-only cache.

For every cache record:

```text
Owner:
Value:
Key fields:
Stable-prefix boundary, if applicable:
Scope: process | workspace | session | turn | provider | model | user
Creation trigger:
Invalidation triggers:
Retention/TTL:
Concurrency control:
Failure behavior:
Sensitive-data class:
Telemetry:
Tests:
```

Verify these invariants:

- Cache keys include every semantic input and exclude irrelevant nondeterminism.
- Provider, model, API family, tool/schema version, prompt version, trust state, workspace/session scope, settings revision, and compaction revision participate when they can change the value.
- Distinct users, workspaces, sessions, branches, trust states, providers, and models cannot read each other’s cached sensitive state.
- Invalidation occurs after accepted settings/model changes, tool or prompt changes, session mutation, compaction, plugin/hook contribution changes, trust changes, and schema/version changes as applicable.
- Atomic publication prevents readers from observing a partially built value.
- Concurrent misses do not create an unbounded stampede or publish results out of order.
- A stale or corrupt local cache fails safely and can be rebuilt from authoritative state.
- A provider cache miss is normal; it does not trigger a semantically identical retry or duplicate an effect.
- Cache retention and data-policy decisions are reviewed separately from performance benefits.
- Caching never replaces validation, authorization, session durability, compaction, or effect-ledger checks.

For stable provider prefixes, verify byte-for-byte stability of system instructions, tool definitions, schemas, and reusable examples. Keep session input, retrieved evidence, and latest tool results in the dynamic tail. Do not pad prompts with low-value content merely to reach a vendor cache threshold.

Measure cache hits, misses, writes, evictions, stale detections, invalidations by reason, hit rate, cached/write tokens, latency, cost, and task result. For each supported provider, use its actual cache controls and usage fields; do not normalize distinct vendor semantics into a fictional common capability.

Run fault cases for stale keys, changed schemas, model switch, provider switch, trust change, branch fork, compaction, concurrent miss, cache corruption, unavailable cache service, and cancellation during population.

## Phase 5 — Audit smart vendor and model management

Map the complete model-source and provider pipeline:

```text
managed/canonical/workspace/imported/runtime sources
  -> parse and validate
  -> deterministic precedence merge
  -> effective provider/model catalog
  -> default and session-frozen selection
  -> capability and limit validation
  -> provider adapter
  -> normalized request/stream/usage/error
  -> retry, reroute, or terminal result
```

Verify:

- One canonical service owns the effective provider/model catalog, source precedence, revisions, and redacted projections.
- Provider definitions distinguish API families such as Responses, Chat Completions, Anthropic Messages, Google Generative AI, and custom adapters instead of assuming wire compatibility from an endpoint shape.
- Model selection validates context/output limits, modalities, tools, thinking controls, streaming, structured output, cache support, and authentication readiness before the request.
- Unknown capability, limit, price, or compatibility metadata stays explicitly unknown; it is not converted into permissive defaults.
- Credential and header references remain references. Raw secrets never reach settings output, logs, events, session records, cache keys, or error messages.
- Source changes use validation, semantic diff, dependency impact, expected revision, atomic write, backup, recovery, and frozen-session warnings where required.
- The effective provider/model and source provenance are observable in runtime snapshots and diagnostics.
- Provider adapters preserve canonical text, thinking, tool-call order, usage, stop reasons, retry metadata, cancellation, and protocol errors.
- Malformed frames, partial tool calls, inconsistent indexes, unknown finish reasons, and missing usage are typed rather than silently treated as success.

### Routing, retries, and fallback

First determine whether authoritative design permits automatic vendor or model routing. If it does not, mark routing policy `UNDEFINED` or `NOT APPLICABLE`; do not invent silent failover.

When routing or fallback is supported, prove that decisions are deterministic, observable, and constrained by:

- required capabilities and context/output limits;
- explicit user, workspace, managed, and session-frozen choices;
- data residency, retention, and trust policy;
- authentication readiness and provider health;
- rate-limit and retry metadata;
- task mode and structured-output requirements;
- cost and latency budgets only after correctness constraints pass; and
- an approved fallback allowlist.

Verify:

- Retry classification belongs to one layer and attempts are bounded, cancellable, and backoff-aware.
- The HTTP adapter does not independently retry a request that the runtime also retries.
- A request may retry or reroute only while effect-ledger state proves no external effect from that logical attempt can be duplicated.
- Provider/model changes do not silently alter prompt semantics, tool schemas, thinking behavior, structured output, cache boundaries, or session replay.
- Fallback emits the original failure category, routing reason, selected destination, capability comparison, usage attribution, and cache consequence without exposing secrets.
- Cost estimates use known versioned prices and preserve unknown values. Cheapest is not automatically smartest.
- A circuit breaker or health signal cannot permanently poison a provider from one transient failure and cannot cross tenant/workspace boundaries improperly.

Run a provider matrix covering supported API families, streaming and non-streaming, tools/no tools, thinking levels, structured outputs, cache hit/miss, 401/403, 404 model, 408/timeout, 429 with retry metadata, retryable 5xx, malformed success responses, connection loss, cancellation, and context overflow.

## Phase 6 — Audit session management

Trace create, name, resume, switch, fork, navigate, rewind, export, stop, import, recovery, and deletion if deletion is an approved surface.

Verify:

- Session identity, branch identity, selected leaf, event identity, sequence, and revision cannot be mixed.
- Stored events use one versioned, runtime-validated canonical format with deterministic projection.
- Model-visible projection is distinct from transcript, diagnostics, display-only, and internal state.
- Appends use optimistic concurrency and reject stale expected revisions without partial mutation.
- Writes are atomic and durable to the documented level; backup recovery cannot silently replace newer valid state with stale data.
- Corruption, unsupported schema versions, partial writes, and migration failures are typed and recoverable without modifying the source unexpectedly.
- Legacy/Pi import leaves the source byte-stable and commits a separate native destination transactionally.
- Resume restores prompt-relevant history, provider/model/thinking selection, tool-call correlations, compaction state, and required policy context exactly once.
- Fork preserves shared ancestry while isolating subsequent context, cache entries, effects, revisions, and settings.
- Session-frozen model/settings values remain stable for the documented boundary.
- No-session mode has explicit persistence and context semantics.
- Cancellation during persistence or compaction yields one deterministic terminal state and does not leave an apparently committed partial turn.

For compaction, test manual, threshold, overflow, retry, failed retry, cancellation, crash/restart, and concurrent session mutation. Compare the next model request and task result before and after compaction. A plausible summary alone is not proof.

Measure load, append, replay, projection, fork, compaction, and recovery latency; record growth by turns/events/bytes; and identify operations whose cost grows worse than the documented or expected complexity. Separate storage cost from model-context cost.

## Phase 7 — Audit agentic-flow management

Trace the canonical loop:

```text
input
  -> intercept/validate
  -> session projection
  -> prompt assembly and budget check
  -> provider/model resolution
  -> inference attempt
  -> normalized decision
  -> tool prepare/validate/policy/approval/effect admission
  -> execution and observation
  -> persistence
  -> next bounded iteration or terminal result
```

Verify:

- Exactly one component owns iteration, provider retries, tool-call limits, total turn deadline, and terminal result.
- Model iterations, provider attempts, tool calls, tool-result size, context growth, and wall time have separate explicit bounds where required.
- Submit, steer, follow-up, cancel, and stop have distinct state transitions and correlation identities.
- Transports continue reading commands while a turn runs when their contract supports concurrent control.
- Cancellation reaches provider readers, tool calls, child processes, hooks, persistence, compaction, output, and background work; shutdown joins owned work before `runtime.stopped`.
- Each tool call is finalized and schema-valid before execution.
- Trust, managed policy, plan policy, peer locks, hooks, approval, adapter restrictions, and the effect ledger run in the canonical pre-effect order.
- Tool results and external effects are applied at most once across retries, reconnects, resumes, fallback, and cancellation races.
- Failed or blocked actions create correlated observations without incorrectly advancing durable state.
- A completion, cancellation, or terminal provider failure cannot enter another inference cycle.
- Streaming and non-streaming representations normalize to the same semantic turn result.
- No runtime event occurs after `runtime.stopped`, and cleanup runs exactly once on success, failure, cancellation, signal, broken pipe, and failed initialization.
- Interactive, print, JSON, and RPC modes share runtime semantics while preserving their distinct output-purity contracts.

Detect efficiency failures such as repeated identical model requests, redundant tool discovery, unbounded retrieval loops, repeated parsing/serialization, retry amplification, cache-miss retry loops, compaction thrashing, session rewrite amplification, output backpressure, or agents continuing after the answer is already terminal.

## Phase 8 — Cross-system invariant and fault matrix

Run these interactions, not only isolated subsystem tests:

| Change or fault | Required checks |
|---|---|
| Prompt/tool schema change | Stable-prefix invalidation, cache miss, new digest, correct session projection |
| Provider/model switch | Capability revalidation, cache separation, frozen-session semantics, usage attribution |
| Session fork | Context ancestry preserved; cache, revision, and effect isolation enforced |
| Compaction | Cache invalidation, replay equivalence, no missing correlation or policy state |
| Provider retry/fallback | No duplicated effects, stable logical turn identity, bounded attempts |
| Trust/settings/plugin change | Relevant context/catalog caches invalidated; permissions not widened |
| Cancellation during cache fill | No partial publication, leaked promise, late event, or poisoned entry |
| Persistence failure after inference | Deterministic recovery; no false committed turn or automatic duplicate effect |
| Large tool result | Bounded context, continuation preserved, task success maintained |
| Output backpressure/broken pipe | Cancellation and cleanup complete; structured output remains valid |

Use deterministic clocks, IDs, provider fixtures, fault injection, normalized traces, and the shared effect ledger. Retain raw receipts with hashes when permitted. Never normalize away event order, session ancestry, request/tool/effect correlation, usage semantics, cache result, provider/model identity, stop reason, exit code, or duplicated effects.

## Phase 9 — Tests, benchmarks, and observability

Map every requirement and finding to an existing test, a missing test, or a benchmark case.

Prefer production-composed behavioral tests over private implementation tests. Reject evidence that can pass with a no-op runtime, fake cache hit, manually emitted success event, synthetic usage, or a session projection that never reaches the model request.

At minimum require coverage for:

- prompt segment ordering, provenance, visibility, deduplication, and byte/token snapshots;
- long-turn growth and compaction thresholds;
- provider-specific cache usage parsing and stable-prefix behavior;
- cache invalidation, isolation, concurrency, corruption, and failure;
- model-source precedence, revisions, redaction, and capability validation;
- provider translation, malformed streams, usage, stop reasons, retries, and fallback policy;
- session create/resume/fork/recovery/import/concurrency/compaction;
- loop bounds, steering, follow-up, cancellation, shutdown, and exactly-once effects;
- interactive, print, JSON, and RPC output purity; and
- task-success guardrails before and after each proposed optimization.

Telemetry must be bounded, structured, redacted, and attributable to request, turn, session, provider, model, cache namespace, and attempt without logging sensitive prompt content. Verify telemetry itself does not create material context, storage, or latency overhead.

## Audit completion gate

The audit is complete only when:

- all five primary systems have a production-reachability map and a verdict;
- every mandatory benchmark case ran or has a named, concrete evidence blocker;
- every supported execution mode and API family is covered or explicitly classified;
- context, cache, vendor/model, session, and agent-loop claims have exact source anchors and runtime evidence;
- cross-system fault cases report the first semantic divergence and effect-ledger result;
- absent telemetry, budgets, policies, credentials, or version-specific upstream evidence are reported rather than guessed; and
- the final direct questions are answered without padding confidence.

If a required live-provider run needs new credentials, spend, network authority, or production data, stop that branch and report the exact missing authority. Continue all deterministic, local, and read-only branches that remain possible. Do not substitute a mock result for the missing live-provider evidence.

## Efficiency scorecard

Create one scorecard row per benchmark case and supported mode/provider combination:

| Field | Required value |
|---|---|
| Case and mode | Stable scenario ID and execution mode |
| Provider/model/API family | Exact identity and capability source |
| Task result | Pass/fail plus verifier |
| Input/cached/write/output/reasoning tokens | Provider-reported or explicitly unavailable |
| Prompt and tool-result bytes | Before and after shaping/compaction |
| Requests/iterations/tools/retries | Exact counts |
| Cache outcome | Hit/miss/write/bypass plus reason |
| Latency | TTFT and total; sample count and p50/p95 where repeated |
| Cost | Versioned estimate or unknown |
| Session work | Load/append/replay/compaction bytes and duration |
| Effects | Registered/executed/blocked/duplicate counts |
| Trace | Normalized hash and first divergence |
| Budget result | PASS/PARTIAL/FAIL/UNDEFINED/UNPROVEN |

Compare baseline and candidate values only on identical fixtures and semantic outputs. Keep an optimization only when the target metric improves without an unacceptable regression in task success, safety, replay, output validity, or effect correctness.

## Required findings format

Order findings by severity: `Critical`, `High`, `Medium`, `Low`.

For every finding provide:

```text
Title:
Severity:
Subsystem: context | cache | vendor/model | session | agentic flow | cross-system
Result: PASS | PARTIAL | FAIL | UNPROVEN | UNDEFINED | NOT APPLICABLE | HOLD
Requirement and authority:
Location and symbol:
Production reachability:
Scenario and mode/provider:
Observed behavior:
Expected behavior or missing decision:
First divergence:
Quantitative evidence:
Correctness/safety guardrail:
Root cause:
Killed alternate explanation:
Smallest recommended change:
Test or benchmark required:
Risk:
Confidence:
```

Clearly distinguish proven defects, performance regressions, missing telemetry, undefined product budgets, architectural opportunities, and documentation drift. Do not present a vendor preference, microbenchmark, token estimate, or cache theory as a defect without runtime evidence and a violated contract.

## Implementation policy

If implementation is explicitly authorized after the audit:

1. Select one proven high-value finding with resolved design and an observable verifier.
2. Add or update the failing behavioral test or benchmark first.
3. Confirm it fails for the expected reason.
4. Implement the smallest coherent change at the owning layer.
5. Run the focused tests and benchmark corpus.
6. Rebuild every changed package.
7. Exercise the real CLI path in every affected mode.
8. Re-run context, cache, session, provider, trace, and effect-safety guardrails.
9. Keep the change only when the target metric improves without a correctness or safety regression.

Do not add a generic cache, provider abstraction, context framework, fallback router, or session rewrite merely because it might be useful. Introduce an abstraction only when repeated production behavior proves one owner and one contract are needed.

Do not add backward-compatibility shims unless explicitly required. Report broad product, data-retention, provider-routing, storage-format, or migration decisions instead of implementing them implicitly.

## Verification

For each changed package, run the applicable sequence:

```bash
yarn workspace <package> test
yarn workspace <package> build
yarn workspace <package> verify
```

Then run applicable repository checks:

```bash
yarn lint
yarn typecheck
yarn test
yarn build
```

After rebuilding, exercise the real CLI and live Octocode surface where applicable:

```bash
npx octocode --help
npx octocode context --compact
npx octocode tools --json
npx octocode tools localSearchCode lspGetSemantics --scheme
```

Exercise the locally built `octocode-agent` in interactive, print, JSON, and RPC modes when those modes are affected. Re-run LSP queries on changed symbols and their callers after implementation. Do not claim success from compilation or unit tests alone.

## Required final deliverables

Return the audit in this order:

1. Executive verdict and highest-risk blockers.
2. Authority, scope, environment, and unresolved-design notes.
3. Actual end-to-end runtime and ownership maps.
4. Reproducible benchmark corpus and baseline methodology.
5. Context-efficiency scorecard.
6. Cache inventory, key/invalidation map, and cache-effectiveness results.
7. Provider/model source, capability, routing, retry, and fallback matrix.
8. Session lifecycle, persistence, replay, recovery, and compaction matrix.
9. Agentic-flow state, cancellation, bound, retry, and effect-safety matrix.
10. Cross-system fault results and first-divergence reports.
11. Findings ordered by severity.
12. Test, benchmark, and observability gaps.
13. Prioritized remediation plan with the smallest dependency-safe work packages.
14. Changes implemented, files changed, and commands run, if implementation was authorized.
15. Remaining risks, `UNDEFINED` budgets/policies, and required decisions.

Finish with direct answers:

- Is the model context the smallest context that preserves correctness and task success?
- Which context sources are duplicated, stale, unbounded, misordered, or incorrectly visible?
- Are stable prompt prefixes actually stable, correctly scoped, and measurably cached?
- Can any cache leak data, survive a semantic change, stampede, or publish partial state?
- Does every supported provider/model use the correct version-specific API, capabilities, limits, usage, stop, retry, and cache semantics?
- Is routing or fallback explicitly authorized, deterministic, observable, capability-safe, and effect-safe?
- Do sessions resume, fork, recover, replay, and compact without context drift or state corruption?
- Is the agent loop bounded, cancellable, retry-safe, and exactly-once for external effects?
- Are interactive, print, JSON, and RPC modes semantically consistent and output-pure?
- Which efficiency claims are proven, which are unproven, and which lack an approved budget?
- What is the smallest next change that improves efficiency without weakening correctness, safety, or session continuity?
