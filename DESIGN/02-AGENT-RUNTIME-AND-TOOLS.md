# Agent runtime and tools

Status: required target design

Scope: the host-neutral turn runtime in `@octocodeai/agent-core` and its native model, tool, and transport adapters. This document defines the behavior required to close the current runtime-flow gaps. It does not define terminal rendering, filesystem session storage, hook discovery syntax, plugin packaging, or Pi-specific translation except where those systems consume the canonical runtime contracts.

## Why this design is required

The current implementation composes typed commands and events, a bounded model/tool loop, correlated assistant tool-call history, schema validation, projected session history, a policy chain, a live-plan gate, lifecycle events, concurrent RPC control, session-owned MCP connections, and explicit OpenAI Chat, Responses, and Anthropic adapters. It is a working native runtime candidate, not a cutover-safe one.

The most consequential current-state gaps are:

- Production composes trust, approval, schema, policy, live-plan decisions, command hooks, registry-owned MCP hooks, and bounded asynchronous hook ownership. Awareness peer-lock coverage, composite-effect classification, and one authoritative durable effect ledger remain incomplete.
- Persistent RPC accepts control input while a submit is active and projects session-bound workers; ACP dynamically projects the active session and requests permission through the official client method. Frame bounds, backpressure, broken pipes, and the full clean built-client corpus remain open.
- OpenAI Chat, Responses, and Anthropic protocol adapters pass focused tests. Credentialed provider runs, hosted tool coverage, classified retry ownership, persisted response state, and the complete provider-retirement matrix remain open.
- MCP connections are session-owned, reuse negotiated catalogs, process progress, invalidate on notifications, and implement bounded elicitation, durable Tasks, provenance, and persisted enablement. Complete subscriptions, authentication variants, restart/fault coverage, and real-host conformance remain incomplete.
- Skills provides contained discovery, list/load, refresh, provenance, budgets, authorized lifecycle operations, and settings controls. Complete dependency semantics, resumed-session provenance, and the clean cross-host corpus remain open.
- RPC subscribes across start and stop and validates request envelopes; remaining work is bounded framing, backpressure, fault isolation, byte-pure built-client coverage, and editor conformance.

These gaps conflict with the required runtime/tool parity, zero-bypass policy, cancellation ownership, prompt snapshots, streaming normalization, and transport corpus in the [test plan](pi-coding-agent-removal/TEST_PLAN.md) and [KPI contract](pi-coding-agent-removal/KPI.md).

## Design principles

1. The core owns semantics; adapters own I/O and provider translation.
2. Every effect is gated before it starts. Missing policy data denies rather than permits a protected effect.
3. One runtime owns one root cancellation scope and joins all owned child work before stopping.
4. Session projection is the durable source of prior model-visible context; display-only and diagnostic entries never leak into the prompt.
5. Commands, events, errors, usage, and stop reasons cross adapter boundaries only in canonical normalized forms.
6. Streaming changes timing, not semantics. Streaming and non-streaming runs of the same provider response produce the same normalized turn trace.
7. A transport may determine presentation, never runtime ordering, policy, or state transitions.
8. Every accepted control mutation is observable and revisioned; every rejected mutation is typed and leaves state unchanged.

## Runtime composition

The native launcher must compose a runtime from explicit ports and immutable startup inputs:

```ts
interface RuntimeComposition {
  session: SessionProjection;
  prompt: PromptAssembler;
  modelCatalog: ModelCatalogService;
  model: ModelPort;
  tools: ToolRegistry;
  lifecycle: LifecycleDispatcher;
  policy: PolicyEvaluator;
  trust: TrustPolicy;
  approval: ApprovalPort;
  plan: PlanPolicyPort;
  peerLocks: PeerLockPolicyPort;
  events: RuntimeEventSink;
  mode: RuntimeMode;
  cwd: string;
}
```

Core interfaces must not import filesystem, process-launcher, browser, OpenTUI, or Pi types. Native adapters may satisfy these ports, but may not broaden a core capability or bypass a core decision.

### Runtime state machine

The legal top-level transitions are:

```text
created -> starting -> ready <-> running -> stopping -> stopped
                       |          |             ^
                       +----------+-------------+
                                  failure -> failed -> stopping -> stopped
```

Requirements:

- `start()` emits `runtime.starting`, completes startup validation and recovery, then emits exactly one `runtime.ready`.
- A turn has exactly one `turn.started` and one terminal `turn.ended` with a canonical stop reason.
- `stop()` is idempotent. It rejects new work, cancels the root scope, waits for the active turn and all owned children, persists the terminal state, then emits `runtime.stopped` exactly once.
- No event or state transition may move a stopped runtime back to ready or running.
- A failed runtime exposes a typed failure and remains stoppable.
- Listener failures are isolated and attributed; an event sink failure follows the event's declared fail-open or fail-closed policy.

## One turn, in required order

For a submitted input, the runtime performs this sequence:

1. Validate the command and runtime state.
2. Create a child turn scope beneath the runtime scope.
3. Dispatch the intercepting input lifecycle event. Apply ordered context and rewrites, then revalidate. A deny or stop decision ends the turn without a model request.
4. Project the session's model-visible history and assemble the prompt from trusted, provenance-bearing fragments.
5. Resolve the effective provider, model, and thinking level against the current model catalog.
6. Start one model attempt and stream normalized deltas.
7. If the model requests tools, finalize one ordered assistant `toolCalls` history entry before any correlated tool-result entries.
8. Prepare, validate, gate, execute, and persist each tool call in stable model order.
9. Append canonical tool results to the next model request and continue the bounded loop.
10. Persist final assistant content, usage, and stop reason; emit one `turn.ended`; close the turn scope.

The loop has separate configured bounds for model iterations, provider retry attempts, tool-call count, and total turn duration. Hitting a bound produces a typed terminal reason and never repeats a completed effect.

## Prompt and model controls

### Prompt assembly

Prompt assembly consumes typed fragments with placement, priority, provenance, trust, and visibility. Required sources include:

- the canonical Octocode system prompt;
- host-neutral runtime instructions;
- trusted user, workspace, managed, and plugin contributions;
- lifecycle-provided context;
- the current user message; and
- model-visible session history after compaction/projection.

Stable ordering is placement, source precedence, priority, discovery order, declaration order, then stable identity. The runtime records a prompt snapshot containing byte count, semantic digest, ordered fragment metadata, and redacted provenance. Untrusted fragments are rejected or excluded according to explicit policy; they are never silently promoted. Custom transcript and diagnostics entries remain outside model context.

### Model selection and thinking

`model.select` resolves provider and model IDs against an effective catalog before mutation. `model.thinking` resolves a canonical level against provider/model capabilities. On success, the runtime commits the new snapshot revision and emits an accepted event. On failure, it returns a typed rejection, emits no accepted event, and preserves the previous selection.

The effective startup model must be visible in `RuntimeSnapshot`; adapter defaults cannot remain hidden. Session-frozen model settings remain stable for the turn. A control change during a turn applies only at a documented safe point, normally the next model attempt or next turn.

Adapters translate canonical thinking levels into provider fields. If the provider cannot represent a requested level, the adapter rejects it before a provider request; it must not silently ignore the value.

## Streaming, retries, usage, and provider errors

The `ModelPort` emits normalized deltas for text, thinking, and incremental tool-call assembly. Tool-call correlation includes a stable call ID, index, name fragments, argument fragments, and a validated finalized input. The runtime must not execute a partial call.

The OpenAI-compatible adapter must:

- parse all complete SSE records, including a final record without a trailing newline;
- treat malformed frames, malformed tool arguments, missing IDs, and inconsistent call indexes as typed provider-protocol failures;
- preserve text, thinking, tool-call order, finish reason, and usage;
- distinguish complete, tool, length, cancelled, filtered, retryable error, and terminal error outcomes;
- parse retry metadata into canonical fields without exposing response bodies or credentials; and
- stop reading immediately when its attempt scope is cancelled.

Retry policy belongs to the runtime, not the HTTP adapter. Only classified retryable failures may retry. Retries use bounded attempts and delay, observe cancellation, emit attempt/retry events, and reuse a stable logical turn identity. An attempt may be replayed only while no external effect from that attempt has started. Completed tool call IDs are recorded in an effect ledger so provider reconnects cannot duplicate effects.

Usage is canonical and monotonic. Each provider response reports per-attempt input, output, cached, and reasoning tokens when available. The runtime publishes per-attempt, per-turn, and cumulative session usage with provenance for unavailable fields. Failed and cancelled attempts report known partial usage without inventing zero as a confirmed provider value.

Provider payloads, authorization headers, prompt bodies, tool arguments marked sensitive, and raw error bodies never appear in public events, RPC responses, logs, or session diagnostics.

## Tool-call pipeline

Every tool call uses this exact pipeline:

```text
model fragments
  -> finalize correlated call
  -> canonical argument preparation
  -> schema validation
  -> resolve canonical effect set
  -> eligible context/rewrite hooks
  -> restart validation and effect resolution after rewrite
  -> trust and managed policy
  -> plan and peer-lock policy
  -> blocking decision hooks
  -> restart every gate after rewrite
  -> approval bound to final digest and effects
  -> shared effect ledger and owned scope
  -> tool.started
  -> execute in owned child scope
  -> zero or more tool.updated
  -> exactly one tool.ended
  -> persist correlated result
```

### Preparation and validation

- Preparation is deterministic and tool-owned through a canonical contract; it may normalize aliases/defaults but cannot perform effects.
- Input is validated against the registered schema after preparation and after any authorized rewrite.
- Invalid input produces a typed blocked/error result that is correlated to the call and can be returned to the model; execution does not start.
- Output and update payloads are validated against registered versions before public emission or persistence.
- Unknown tool names are typed unsupported-capability results.
- Duplicate tool names, call IDs, starts, terminal results, or effect ledger entries fail closed.

### Policy order and receipts

The canonical policy order is:

1. tool capability and effect classification;
2. eligibility and authority for context/rewrite hooks;
3. workspace trust and managed-only restrictions;
4. plan policy;
5. peer-lock conflict policy;
6. blocking hook decisions;
7. approval policy;
8. adapter/environment restrictions; and
9. shared effect-ledger admission.

The policy request includes immutable session/turn/call identity, cwd, runtime mode, trust snapshot, tool provenance, prepared argument digest, effect class, approval requirement, plan requirement, and relevant lock targets. Policies cannot receive arbitrary mutable runtime objects.

Every policy returns an ordered receipt. Deny wins. Missing trust, plan, lock, or approval information denies whenever the tool definition requires that information. Hook execution has its own source-trust, authority, timeout, and effect boundary. Approval is requested only after all non-interactive gates allow, and its decision is bound to the exact prepared-argument digest and effect set. A rewrite invalidates validation, classification, policy, hook-decision, approval, and ledger receipts and restarts the boundary.

Effect classification must describe actual effects, not catalog location. A network tool that clones or writes is at least a write effect as well as network-capable. The runtime must support composite effects or a conservative maximum-risk classification.

### Execution and cancellation

Execution receives a child scope owned by the turn. Process and background work must be registered beneath that scope. Cancellation propagates once; late updates are discarded and diagnosed. A tool emits exactly one terminal `tool.ended` outcome: success, error, blocked, or cancelled. A throwing update callback or persistence failure cannot cause the tool effect to be repeated.

## Steering, follow-up, cancellation, and shutdown

The three input operations have distinct semantics:

- Submit starts a new turn when the runtime is ready. Concurrent submit is queued or rejected according to one documented contract.
- Steer targets the active turn. It is delivered at the next model-safe point and becomes model-visible context within that turn. If no turn is active, it returns a typed rejection.
- Follow-up queues a new turn after the active turn. FIFO order is stable. If no turn is active, it behaves as a documented queued submit rather than being relabeled silently.

Transports must continue reading commands while a turn executes. Runtime command dispatch returns either an immediate acknowledgement with operation identity or a correlated terminal result without blocking the input pump.

Cancellation targets an explicit operation identity when available. Cancelling with no matching active operation is an idempotent no-op or typed not-active response; it never poisons a future turn. Cancellation before submit, during provider streaming, during tool preparation, during tool execution, and during result persistence each reaches exactly one terminal state.

Shutdown rejects new submit/steer/follow-up commands, cancels pending follow-ups and the active root scope, waits for provider readers, child processes, hooks, tools, persistence, and event delivery, then closes transports. `runtime.stopped` is the last runtime lifecycle event.

## Transport semantics

All transports subscribe before `runtime.start()` and remain subscribed through `runtime.stop()`. They consume the same canonical events; presentation differences are explicit.

| Concern         | Interactive                  | Print                                              | JSON                                   | RPC                                                       |
| --------------- | ---------------------------- | -------------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| Input pump      | Concurrent                   | One initial submit plus signal/timeout             | Concurrent if commands are exposed     | Concurrent, correlated commands                           |
| Output          | Semantic terminal projection | Final text on stdout; diagnostics on stderr        | JSONL events only                      | Versioned JSONL events and responses only                 |
| Tool updates    | Rendered                     | Suppressed or summarized by contract               | Canonical events                       | Canonical events                                          |
| Runtime failure | Visible and typed            | Nonzero exit                                       | Typed terminal record and nonzero exit | Correlated failure; runtime remains healthy when possible |
| Cancellation    | Key/signal/command           | Signal/timeout                                     | Signal/command                         | Correlated command                                        |
| Lifecycle       | Ready through stopped        | Ready through stopped in JSON form when applicable | Complete ordered trace                 | Complete ordered trace                                    |

RPC parsing validates the full discriminated command schema, rejects unknown fields where the schema requires it, enforces frame-size limits, and returns a correlated outer response:

```ts
type RpcResponse =
  | { protocolVersion: 1; requestId: string; ok: true; data?: unknown }
  | {
      protocolVersion: 1;
      requestId: string;
      ok: false;
      error: RuntimeErrorData;
    };
```

A runtime command failure is an outer `ok: false`, not successful transport data containing an inner failure. Parse errors without a recoverable request ID use a protocol-error record; validation errors with an ID are correlated. One malformed frame does not stop the runtime or corrupt event sequencing.

Text print mode writes only final user-facing assistant text to stdout. JSON and RPC modes never emit terminal control sequences, logs, progress prose, or non-JSON bytes to stdout. Exit code is derived from the terminal runtime/turn result, not hard-coded success.

## Context, routing, and interoperability additions

The runtime owns one context manifest per turn. It records each instruction, skill, MCP resource, semantic-map slice, deferred tool schema, and resumed-history segment with source identity, trust, precedence, revision, token cost, truncation decision, and cache-stability class. Stable trusted prefixes precede variable session/turn material. Duplicate content is removed by source-aware identity, not by lossy text similarity.

Semantic context uses Octocode AST discovery followed by LSP definition/reference/caller/type proof. It is token-budgeted and source-linked; relevance is not identity proof. If a language server is missing or stale, the adapter emits an explicit degraded receipt and uses a bounded textual fallback.

Tool discovery first filters by execution-scope capability and policy, then ranks a bounded search result and loads only selected schemas. Search cannot reveal or activate a tool that the current scope could not otherwise enumerate.

Model routing is a policy service over the effective catalog. A route names its trigger, allowed source and destination, capability comparison, consent rule, scope, cost/rate reason, and receipt. Silent fallback is permitted only for explicitly allowlisted equivalent internal calls; user turns cannot silently lose tools, thinking, context, modality, or a configured billing boundary.

The ACP adapter is a transport, not another runtime. It maps initialize/authentication, session new/list/resume/close/fork, prompt/cancel, mode/config, progress, permissions, client filesystem/terminal, and MCP into canonical ports. Upstream schemas are pinned and generated; at least two independent client implementations must pass before the adapter is considered conformant.

MCP durable tasks remain behind an extension-specific capability. Task identifiers are unguessable and authorization-bound; TTL, concurrency, polling, update, cancellation, restart, and audit behavior are bounded and version-tested.

## Acceptance criteria

The runtime/tools design is complete only when all of the following are true:

- A new and a resumed session produce approved prompt byte/segment snapshots, and prior model-visible turns are present exactly once.
- Trusted, untrusted, managed-only, plan-restricted, peer-locked, approval-denied, and approval-granted tool cases all produce the expected pre-effect decision and one ordered receipt set.
- No protected effect runs with missing required policy input. Actual write-capable tools are never classified as read/network-only.
- Lifecycle context and rewrites affect the model/tool request before execution; lifecycle deny prevents the effect.
- Streaming and non-streaming fixtures normalize to the same text, thinking, tool calls, usage, and stop reason.
- Retryable disconnects retry within bounds without duplicating a turn or tool effect; terminal failures do not retry.
- Tool arguments are prepared and validated before execution, rewritten arguments are revalidated, and updates/results are version-validated.
- Model and thinking changes are either capability-validated and visible in the snapshot/provider request or rejected without state mutation.
- Steer and follow-up work while a model stream is active in interactive and RPC modes; cancel remains responsive during model and tool work.
- Cancellation and shutdown always yield one turn terminal event, one runtime terminal event, and zero owned children, readers, timers, or processes.
- Print, JSON, and RPC observe lifecycle events in canonical order; malformed RPC input is typed/correlated where possible; command failures are outer failures.
- Public events, stored diagnostics, stdout, and RPC output contain no provider secrets or prohibited raw payloads.
- Native and Pi-adapter conformance fixtures produce the approved normalized trace for every shared scenario.

## Mandatory tests

### Core unit tests

- Runtime state transition table, illegal transitions, idempotent start/stop, and stop-during-turn join.
- Exactly-once turn/tool/runtime terminal events under success, failure, cancellation, listener failure, and persistence failure.
- Prompt ordering, trust rejection, exact bytes/digest, model-visible projection, diagnostics exclusion, resume, and compaction continuation.
- Model selection/thinking acceptance and rejection with revision/state assertions.
- Lifecycle stable ordering, rewrite composition, revalidation, deny-wins, timeout, cancellation, recursion, and error attribution in the actual kernel path.
- Policy matrix for trust, managed-only, plan, peer locks, approval, adapter restrictions, missing inputs, rewrite invalidation, and receipts.
- Tool prepare/validate/rewrite/revalidate/execute order; unknown tool; invalid input/output/update; duplicate call ID; throw before and after update.
- Multiple ordered tool calls with the assistant tool-call history entry preceding correlated results.
- Bounded iterations, bounded retries, retry cancellation, retry-after handling, and no duplicate effect after reconnect.
- Submit/steer/follow-up queue semantics and cancellation at every safe-point boundary.
- Per-attempt, per-turn, and cumulative usage with partial/unknown fields.

### Native adapter tests

- Streaming SSE split at every byte boundary, CRLF, multiple records per chunk, final record without newline, `[DONE]`, malformed JSON, and provider disconnect.
- Incremental parallel tool calls with fragmented IDs, names, and arguments; malformed arguments and inconsistent indexes.
- Every supported finish reason and typed HTTP/network/abort/retry classification; raw body and credential redaction.
- Provider request snapshots for effective model, thinking, tool schema, tool choice, assistant tool-call history, and tool-result correlation.
- Live catalog effect classification including clone/write/process-capable tools, plus schema validation before the CLI executor.
- Child-process cancellation, timeout, late callback suppression, and no surviving process.
- Session resume feeds projected history and the assembled prompt into the first provider request.

### Transport and conformance tests

- Real kernel tests—not no-op runtime fixtures—for startup through stopped in interactive, print, JSON, and RPC.
- RPC concurrent submit plus steer/follow-up/cancel; multiple request correlations; out-of-order operation completion with stable event sequence.
- Full action-specific command validation, unknown version/type, invalid payload, oversized line, command failure, and recovery on the next valid frame.
- Subscribe-before-start and unsubscribe-after-stop assertions; JSONL/stdout purity and text-mode exit codes.
- Cancellation races at submit/start/delta/tool-start/update/end/persist/shutdown boundaries with open-handle and child-process checks.
- Golden normalized Pi/native traces for prompt, text, thinking, multi-tool updates/results, policy blocks, retries, usage, errors, steering, follow-up, cancellation, and every transport.

Test doubles may isolate one boundary, but at least one mandatory test per safety and lifecycle invariant must compose the production kernel, production policy chain, production event path, and the relevant native adapter. A synthetic always-deny policy or manually emitted event cannot be used as evidence that the production path enforces the same behavior.
