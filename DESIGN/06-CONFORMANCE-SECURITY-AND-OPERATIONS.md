# Conformance, Security, and Operations

## Goal

Prove that the native host matches the required Pi behavior while preserving a zero-bypass security boundary, deterministic external effects, actionable observability, and a tested rollback path.

## Replace synthetic conformance

The conformance runner must invoke real adapters:

- **Baseline adapter:** the actual Pi extension/harness composition.
- **Candidate adapter:** the actual native launcher/kernel composition.
- **Pure mode:** no external effects; both hosts produce normalized projections.
- **Shadow mode:** candidate proposes effects but the ledger prevents execution.
- **Live mode:** exactly one designated host executes each external effect.

Scenario handlers must not manufacture success events. Each scenario supplies real inputs and captures real host events, decisions, effects, persisted records, protocol output, and terminal state.

## Normalization rules

Normalize only nondeterministic representation:

- timestamps may become relative sequence markers;
- temporary roots may become stable logical roots;
- generated IDs may be bijectively mapped while preserving equality and ancestry;
- provider-specific noise may be removed only through an explicit rule.

Do not erase session ancestry, request/effect correlation, containment-relevant paths, ordering, visibility, terminal reasons, policy decisions, or error classes.

## Effect ledger

- Allocate one ledger per comparison run, shared by baseline and candidate.
- Require a stable effect ID, semantic operation, target, input digest, owner, and mode.
- In live mode, permit only the designated executor.
- Reject duplicates across hosts, retries, reconnects, and resumed sessions.
- Record proposed, approved, started, committed, failed, cancelled, and compensated states.
- Treat adapter side effects not registered with the ledger as a conformance failure.

## Zero-bypass security gates

Every effect path must use the same ordered boundary:

1. Normalize and validate input.
2. Resolve trust and workspace scope.
3. Check managed policy.
4. Check plan and peer-lock constraints.
5. Run blocking pre-effect hooks.
6. Resolve approval requirements and obtain a decision.
7. Register the effect with the ledger/ownership scope.
8. Execute with cancellation and deadline propagation.
9. Normalize, redact, persist, and emit the result.

No CLI, RPC, plugin, hook, retry, migration, resume, or internal helper may call an effect port around this boundary.

## Observability

Emit structured, versioned records for runtime/session/turn/request/effect identity, policy and approval decisions, model/provider attempts, usage, retry attribution, tool lifecycle, hook/plugin timing, session commits, compaction, transport errors, shutdown, and recovery.

Diagnostics must be useful without containing prompts, credentials, raw environment values, hook/plugin secrets, or unbounded tool output. Redaction happens before persistence and presentation.

## Operational gates

### Shadow

- Candidate receives representative production inputs.
- Candidate effects are ledger-blocked.
- Projection mismatches are classified and reviewed.
- No unregistered external effect occurs.

### Canary

- Native is enabled for an explicit cohort and can be disabled immediately.
- Error, cancellation, terminal-restoration, session-recovery, and mismatch thresholds are defined before rollout.
- Rollback preserves session data and returns users to a functioning Pi path.

### Native default

- All traceability checks pass.
- Platform packaging/PTY acceptance passes on every supported target.
- No critical/high conformance or security mismatch remains.
- Rollback has been exercised against the release artifact.

### Pi removal

- Native default has completed its observation window.
- The compatibility selector and rollback artifact remain available for the declared rollback window.
- Pi package dependencies, launch code, documentation, tests, and configuration are removed together.
- A clean install and upgrade from the previous supported release both pass.

## Mandatory scenarios

- Prompt assembly and resumed context.
- Streaming text/thinking/tool calls, malformed frames, retry, rate limiting, and provider errors.
- Tool validation, approval, denial, trust, plan, peer lock, cancellation, and duplicate prevention.
- Steering, follow-up, idle/active cancellation, shutdown, and process interruption.
- Session create/resume/switch/fork/rewind/export/migration/recovery/compaction.
- Hook block/rewrite/context and plugin activation/update/unload.
- Interactive PTY, narrow terminal, Unicode, mouse/focus/resize, restoration, and headless purity.
- Settings mutations, conflict, rollback, trust, origin/token/CSP, and secret redaction.
- Print, JSON, and RPC lifecycle, correlation, error, concurrency, and exit behavior.

## Exit criteria

Conformance is complete only when real adapters pass in pure and shadow modes, the designated live-effect suite reports no duplicate/unregistered effects, every supported platform passes its packaging and PTY checks, and rollback succeeds from the actual release artifact.
