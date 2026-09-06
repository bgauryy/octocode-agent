# Agent core architecture

`@octocodeai/agent-core` is the host-neutral semantic boundary for every Octocode
agent host. Native and Pi adapters depend inward on core; core has no runtime
dependencies and does not import host implementations.

## Ownership

- `contracts/` owns versioned commands, runtime events, errors, identities,
  models, sessions, settings, tools, UI capabilities, workers, and host ports.
  UI interaction requests may carry renderer-neutral workflow-step metadata;
  the corresponding result vocabulary includes an explicit `discuss` outcome.
  Core does not sequence questions or render controls: the owning host workflow
  advances state and the presentation adapter materializes the active step.
  Core also owns the shared text, select-option, and workflow-step ceilings so
  tool producers and renderers cannot drift onto incompatible limits.
- `contracts/user-input.ts` owns ordered version-one text and image parts, image
  media/signature validation, byte and count ceilings, and redacted attachment
  metadata. Inline base64 is a bounded host bridge; durable blob references remain
  host work and must preserve part order and integrity.
- `runtime/` owns the agent kernel, prompt assembly, canonical registries,
  deny-first policy order, retry, execution scopes, worker supervision, and the
  effect ledger.
- `events/` owns ordered lifecycle dispatch and decision aggregation.
- `schemas/` owns JSON Schema validation and the RPC/event schema boundary.
- `session/` owns revision-safe append/replay, deterministic projections,
  transactional persistence contracts, import, and durable compaction.
- `settings/` and `models/` own deterministic registries, precedence,
  redaction, revision checks, and mutation semantics.
- `hooks/` and `plugins/` own reviewed hook contracts, transactional
  contribution publication, capability leases, and reverse unload.
- `contracts/semantic-context.ts` and `runtime/semantic-context.ts` own the
  versioned semantic-context manifest, strict decoding, workspace-relative
  provenance, deterministic whole-record token budgeting, degraded-evidence
  receipts, and escaped ephemeral placement before the current user input.
  Hosts supply AST/LSP evidence through `SemanticContextProviderPort`; malformed
  or over-budget evidence is omitted instead of entering model history.
- `contracts/permissions.ts` and `runtime/permissions.ts` own the strict
  permission request, resolved risk, reviewer outcome, and decision table. Runtime
  modes do not alter this contract. Trusted `allow-all` can waive promptable review,
  but mandatory review and every trust, plan, lock, capability, and effect guard
  remain active. The kernel binds the resulting decision into the effect receipt.
- `contracts/context-artifacts.ts` and `runtime/context-assembler.ts` own strict
  versioned context artifacts and deterministic projection. Artifacts carry source,
  freshness, retention, rehydration, trust, visibility, digest, and cache-class
  metadata. The assembler validates references, removes duplicates and superseded
  artifacts, budgets whole artifacts, records every drop, and computes stable-prefix
  identity from only stable and epoch blocks. Summary, plan, skill, memory, evidence,
  and tool-result content is escaped and explicitly presented as data, never policy.
- `contracts/checkpoints.ts` owns the strict version-one filesystem transition
  and recovery vocabulary. `events/checkpoints.ts` owns canonical prepared,
  recovered, and rewind receipts, their versioned RPC validation, and the narrow
  checkpoint-only runtime ingress. The ingress validates before persistence,
  preserves ordinary runtime ordering/subscriber semantics, and rejects use
  outside an active runtime; it cannot publish other lifecycle types. Recovery
  is observational: `complete`, `partial`, and `uncertain` never authorize replay
  of an existing effect.

Core persistence invariants are backend-independent: revision-zero loads are
absence, so resume/fork reject them; an admitted effect may execute only after
`acquired`; and a crash-left `started` effect is terminalized as `uncertain`
before replay. Native file, Rust, or future stores must preserve those exact
semantics. Newly minted version-one admission receipts add a canonical SHA-256
digest, an authorization expiry, and the evaluated policy-chain revision. The
three fields are atomic and strictly validated. Expiry can reject only a first
admission: an existing ledger record always wins, so expiration can never make
an effect replayable. Legacy version-one receipts remain readable for migration
compatibility but are not emitted by the kernel.

Preflight compaction is model-aware and bounded to one attempt per iteration.
The soft threshold is advisory: if immutable prompt material, tool schemas, or
rehydrated context prevent a smaller measured request, the kernel admits it when
it remains below the hard model input budget. At or above that hard budget it
fails before provider admission. Provider-reported input overflow still receives
one compact-and-retry attempt and requires request-size progress.

Hosts with model selection inject `resolveModelLimits` from their effective model
catalog. Core resolves and validates the active model's limits at each context
preflight; a smaller selected model cannot inherit the launch model's larger
input budget. Hosts with a fixed model may supply static `modelLimits` instead.
An unknown dynamic limit remains unknown rather than falling back to stale limits.
`resolveModelInputBudget` is the shared derivation for core preflight and native
telemetry: model context capacity minus output reserve and the safety margin.
A host's observation of this value does not replace core admission.

## Event contract flow

Core uses one canonical runtime lifecycle vocabulary. Explicit projectors adapt
that vocabulary for persistence, public transport, and presentation:

```text
typed producer
  -> RuntimeEventOf<TType>
  -> LifecycleBus validation and ordered decisions
  -> canonical RuntimeEvent
       |-> durable SessionEvent/SessionStoredEvent projection
       |-> redacted public transport projection and strict RPC envelope
       `-> renderer-neutral NativePresentationEvent projection in the host
```

`contracts/events.ts` owns event names, envelopes, and `AgentEventPayloadMap`.
`schemas/rpc.ts` owns the matching wire validators. Adding a payload to the map
without adding its validator is an incomplete contract change. A lifecycle bus
validates the initial payload before it invokes a handler and validates every
rewrite before it becomes the next handler's input.

Events with canonical schemas narrow by their `type` discriminant. Events that
still represent host-specific or vendor-specific data remain explicitly opaque
and must be decoded once at the owning adapter. Consumers must not apply a
package-wide `Record<string, unknown>` cast to the event stream.

## Host boundary

Host adapters own filesystem persistence, process execution, provider SDKs,
transport framing, UI rendering, browser composition, approvals, and Pi
compatibility. They inject those capabilities through core ports. Core must not
read ambient host state or depend on Pi, OpenTUI, browser, launcher, filesystem,
or provider implementation types.

## Known convergence work

`AgentEventPayloadMap` covers the core-produced runtime, turn, input, provider,
context, tool, worker, and compaction payloads used by native presentation. The
canonical worker and compaction version-one payloads have strict RPC validators.
Worker lifecycle events deliberately expose only presentation-safe state: start is
`running`; stop is one terminal outcome. Rich snapshots, capabilities, reasons, and
handback data never enter that event boundary. Some session, UI, settings, resource,
and plugin events remain explicitly opaque. Extend the payload map and the versioned RPC validator
together rather than adding host-local casts or parallel event types. A future
exhaustive validator registry must dispatch by both event type and event version.
Core composes and tests the semantic-context boundary. This increment leaves the
native host without a capability-rooted provider. The external Octocode catalog
must publish a versioned semantic-map contract before native or Pi enables this
path; text fallback must remain explicitly degraded and cannot claim semantic
identity or dependency completeness.
The native launcher uses the context-artifact assembler for its typed initial and
post-compaction projections. The stable system prompt and provider-required message
framing remain outside that artifact budget by design. Other hosts and producers must
use the same contract before their telemetry can claim artifact drop receipts or
stable-prefix identity.
Remaining program-level decisions and closure gates are tracked in
[`DESIGN/LEFTOVERS.md`](../../DESIGN/LEFTOVERS.md).
