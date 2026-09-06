# Octocode Agent completion plan

Status: active. Release decision: `HOLD`.

This file is the only repository-level plan for unfinished Octocode Agent work.
Architecture documents describe implemented behavior; tests and production code
remain the source of truth. Do not add dated implementation reports or evidence
documents under `DESIGN/`.

## Completion contract

The release can move from `HOLD` only when all five workstreams meet their
acceptance gates and the root release gate passes from a clean commit.

Every change must follow these rules:

- Start with a failing test that represents observable behavior or a safety contract.
- Put semantic invariants in the owning package instead of duplicating behavior in
  adapters.
- Keep hidden chain-of-thought, credentials, private worker prompts, and opaque
  runtime payloads out of presentation and diagnostic output.
- Exercise the real built CLI, native Rust services, persistence, and process
  boundaries when the change affects them.
- Record release evidence as CI artifacts or release records, not as additional
  development documents in this repository.
- Keep rollback possible until the final canary and observation gates pass.

The owning architecture references are:

| Area | Source of truth |
|---|---|
| Runtime, sessions, context, compaction, policy, and effects | [Agent core architecture](../packages/octocode-agent-core/ARCHITECTURE.md) |
| SQLite durability and contained filesystem services | [Rust services architecture](../packages/octocode-agent-core-rust/ARCHITECTURE.md) |
| Native providers, tools, MCP, workers, settings, and OpenTUI | [Native architecture](../packages/octocode-agent/ARCHITECTURE.md) |
| Terminal semantics and interaction | [Terminal design system](../packages/octocode-agent/docs/TERMINAL_DESIGN_SYSTEM.md) |
| Widget composition, states, actions, and accessibility | [Widget design](WIDGETS.md) |
| Ask, Plan, root-cause analysis, execution, and recovery flows | [Workflow design](WORKFLOWS.md) |
| Workers and parallel execution | [Parallelism and workers](../packages/octocode-agent/docs/PARALLELISM_AND_WORKERS.md) |
| Plans, work, locks, messages, and verification | [Awareness architecture](https://github.com/bgauryy/octocode/tree/main/packages/octocode-awareness/ARCHITECTURE.md) |

## Workstream 1: Terminal UX polish

Goal: make every meaningful lifecycle state understandable, compact, accessible,
and safe in both visual and alternate output.

### Skill activity

- [x] Replace generic Skill mutation output with dedicated cards for discovery,
  activation, deactivation, refresh, policy rejection, completion, and failure.
- [x] Show the Skill name, source scope, safe action, state, and bounded result.
- [x] Coalesce discovery bursts without hiding a terminal state or required action.
- [x] Add secret-shaped and oversized input tests for every Skill summary path.

### Session receipts

- [x] Show the session display name and a short public identifier after create,
  resume, switch, and fork operations.
- [x] Report restored visible-message count, retained model-context item count,
  context-token occupancy, and committed compaction state when available.
- [x] Distinguish a fresh session, an empty resumed session, a compacted session,
  and a partially recovered session.
- [x] Keep session receipts bounded and avoid exposing database keys, paths, or
  private message content.

### Notification quality

- [x] Define deterministic coalescing keys for repeated provider, discovery, trust,
  settings, plugin, worker, and compaction notifications.
- [x] Coalesce repeated progress updates while preserving the first transition,
  latest progress, terminal result, failure, and required action.
- [x] Prevent stale notifications from surviving session replacement or action
  completion.
- [x] Test burst ordering, interleaving operations, cancellation, retries, and
  narrow-terminal behavior.

### MCP and worker lifecycle scenarios

- [x] Add real PTY scenarios for MCP discovery, connection, tool start, progress,
  elicitation, cancellation, success, failure, reconnect, and catalog changes.
- [x] Add real PTY scenarios for worker spawn, running progress, message delivery,
  follow-up, steering, graceful cancellation, failure, completion, and cleanup.
- [x] Verify that visual and alternate output expose the same sanitized lifecycle
  meaning without raw arguments, internal worker IDs, or private prompts.
- [x] Verify footer priority when MCP, workers, approvals, compaction, and provider
  requests overlap.

### Accessibility and fault behavior

- [x] Test every pointer action through its keyboard equivalent and test supported
  mouse interactions independently.
- [x] Run screen-reader and `--accessible` task scenarios for messages, tools,
  plans, approvals, workers, errors, resizing, and exit.
- [x] Keep sensitive terminal fields fail-closed until a masked-input contract is
  implemented and verified across echo, history, paste, redraw, output,
  diagnostics, cancellation, and restoration paths.
- [x] Inject renderer exceptions, process crashes, interrupted streams, resize
  storms, and shutdown races.
- [x] Prove terminal mode, cursor, paste mode, alternate screen, child processes,
  and temporary resources return to their original state after every exit path.

Acceptance gate:

- All lifecycle families have typed, bounded, and redacted presentation coverage.
- Real PTY scenarios pass for commands, MCP, workers, images, multiline paste,
  cancellation, faults, signals, resizing, and restoration.
- Keyboard-only and assistive-output task sets pass on every supported terminal.
- No hidden reasoning, credentials, private prompts, or raw lifecycle payloads
  appear in visual, alternate, transcript, history, or diagnostic output.

## Workstream 2: Workers and orchestration

Goal: prove bounded worker execution and coordination across worktrees, processes,
restarts, and failure boundaries.

Decision baseline:
[Native Worker Orchestration, Isolation, and Handoff RFC](../.octocode/rfc/native-worker-orchestration-lifecycle/RFC.md).
The design and foundational lifecycle implementation are complete; the remaining
scenario matrix and release evidence stay open. Use the
[implementation plan](../.octocode/rfc/native-worker-orchestration-lifecycle/IMPLEMENTATION.md)
and [verification contract](../.octocode/rfc/native-worker-orchestration-lifecycle/KPI.md)
to close the items in this workstream.

- Keep the current checkout as the default. Create a worktree only after an
  explicit user or policy choice, and never present a worktree as a security
  sandbox.
- Require positive ownership, workspace identity, lock-token, and generation
  checks before worktree reuse, refresh, discard, or cleanup. Retain without
  mutation when any proof is missing or the checkout contains changes.
- Stage integration in an owned clean worktree. Preview the result and require
  explicit confirmation plus a final compare-and-swap check before changing the
  user's checkout.
- Use addressed, ordered, generation-fenced mailboxes with at-least-once claim,
  idempotent command application, and exactly-once durable settlement. Mark an
  ambiguous pipe write as uncertain instead of replaying it automatically.
- Treat each worker and its descendants as one owned process containment unit.
  Keep session, trust, permissions, capabilities, effects, plan ownership, and
  communication leases in one immutable authority envelope.

### Worktree lifecycle

- [x] Verify create, retain-on-dirty, deterministic integration, explicit apply,
  discard, and cleanup behavior.
- [ ] Verify owned worktree reuse and refresh across repeated runs and restart.
- [x] Cover dirty owned worktrees, conflicting worker changes, and detached or
  advanced integration targets.
- [ ] Cover dirty source trees, missing branches, partial merges, and process
  crashes during create, integration, and discard.
- [x] Prove that cleanup never deletes an unowned checkout or user change.

### Mailbox and handoff

- [x] Run multi-process mailbox tests for ordering, addressed delivery, leases,
  duplicate suppression, backpressure, and bounded retention.
- [x] Verify one-shot seal, drain, terminalization, settlement, and acknowledgement
  after worker completion against durable Rust state.
- [ ] Verify handoff before completion, during active tools, and across crash or
  restart at each handoff phase.
- [x] Cover dead pipes, written-without-response uncertainty, generation fencing,
  and refusal to replay possibly delivered messages after restart.
- [ ] Cover stalled readers and abandoned leases across crash recovery.

### Cancellation and ownership

- [x] Verify graceful cancellation, forced termination, timeout escalation, orphan
  detection, and descendant-process cleanup.
- [x] Prove that only a root agent creates workers and every child remains a
  depth-one leaf without worker-creation capability.
- [x] Bind every worker action to the owning session, trust decision, permission
  mode, capability ceiling, effect receipt, plan state, and communication lease.
- [x] Reject stale, cross-session, cross-workspace, and ownership-mismatched
  commands without changing worker state.

Acceptance gate:

- Shared checkout remains the default, and every interface asks for confirmation
  before worktree creation or integration. Worktree and operating-system sandbox
  labels remain distinct in every interface.
- The worktree matrix passes without data loss or unowned cleanup.
- Multi-process messaging preserves ordering, fencing, and bounded delivery under
  backpressure, restart, and crash injection.
- One accessible orchestration surface exposes plan ownership, worker progress,
  messages, cancellation, handoff, conflicts, and retained-resource recovery.
- Every terminal worker state settles exactly once as completed, failed, cancelled,
  or force-terminated.
- No child process, lease, lock, worktree, or temporary resource remains after a
  settled run.

## Workstream 3: Durability

Goal: prove that committed state survives faults and ambiguous operations without
silent loss, duplicate effects, or unsafe replay.

### Database and migration faults

- [ ] Test malformed records, corrupted pages, missing indexes, incompatible schema
  versions, interrupted migrations, rollback, and recovery from backups.
- [ ] Verify fresh install, supported upgrade paths, repeated migration, and
  downgrade refusal. Preserve bytes through export and import.
- [ ] Test stale writers, compare-and-swap conflicts, fencing-token rollover,
  concurrent readers, and process restart during transactions.

### Session and response integrity

- [ ] Cover partial assistant messages, interrupted provider streams, temporary
  state, failed compaction commits, and restart faults between admission and
  settlement.
- [ ] Prove replay equality for committed messages, context artifacts, effects,
  plans, worker messages, and automation state.
- [ ] Preserve admitted effect order and mark crash-left started effects as
  uncertain instead of replaying them.

### Context and compaction

- [ ] Test context-window overflow, repeated threshold compaction, manual compaction
  during active work, cancellation, retries, and restart recovery.
- [ ] Verify retained-reference validity, stable prompt prefixes, cache-read and
  cache-write accounting, and bounded rehydration against real provider requests.
- [ ] Prove that visible history, retained model context, summaries, and memory
  projections remain distinct after resume, switch, fork, import, and export.

Acceptance gate:

- The corruption, migration, stale-writer, interrupted-write, and replay corpus
  passes against the packaged Rust actor.
- No committed record disappears, duplicates, or changes semantic order after
  restart or migration.
- Every uncertain effect remains fenced from automatic replay.
- Compaction remains bounded and restart-safe. Cache behavior stays stable at and
  beyond the configured context limit.

## Workstream 4: Security

Goal: prove that every execution route crosses the same validation, policy, trust,
approval, effect, and settlement boundaries.

### Zero-bypass matrix

- [ ] Test model calls, base tools, Octocode tools, MCP, hooks, plugins,
  automations, workers, RPC, and ACP through every permission mode.
- [ ] Verify schema rejection, input-sensitive policy, trust, managed policy, plan
  and lock rules, capability ceilings, mandatory approval, effect admission,
  bounded execution, cancellation, and settlement.
- [ ] Test direct calls, retries, fallback providers, restored sessions, scheduled
  actions, worker commands, and protocol-originated requests.
- [ ] Prove that `allow-all` bypasses only promptable approval and never bypasses a
  mandatory boundary.

### Secrets and spoofing

- [ ] Inject credentials and secret-shaped values into settings, provider errors,
  MCP results, tool arguments, plugin output, worker messages, session exports,
  logs, notifications, and alternate output.
- [ ] Test plugin identity spoofing, changed hashes, path substitution, manifest
  confusion, stale activation leases, partial activation, and rollback residue.
- [ ] Test MCP server identity changes, redirect confusion, origin confusion, OAuth
  state mismatch, callback replay, credential revocation, and catalog replacement.

### Capability and rollback safety

- [ ] Approve explicit plugin capabilities for filesystem, process, network, MCP,
  model, secret, settings, and UI contributions.
- [ ] Verify least-privilege capability projection and rejection of undeclared or
  escalated operations.
- [ ] Test update, restart, rollback, failed rollback, and recovery without leaking
  secrets or retaining unauthorized capability.

Acceptance gate:

- Every zero-bypass cell has an executable receipt and no unsupported silent skip.
- Secret-shaped values remain absent from every user-visible, persisted, exported,
  and diagnostic surface.
- Spoofed, changed, stale, or capability-mismatched extensions fail closed.
- Update and rollback restore the exact approved capability and secret state.

## Workstream 5: Configuration

Goal: make one revisioned settings registry authoritative across CLI, runtime,
browser, sessions, and supported adapters.

### Registry convergence

- [ ] Inventory every settings reader, writer, default, environment override, and
  compatibility source.
- [ ] Move remaining direct writers behind the revisioned settings service and
  remove duplicate parsing, validation, and redaction logic.
- [ ] Define application timing for immediate, next-turn, next-session, and
  restart-required settings.
- [ ] Preserve protected keys, source provenance, revision preconditions, atomic
  writes, and sanitized projections.

### End-to-end settings surfaces

- [ ] Test Models: discovery, selection, fallback order, credentials, health checks,
  provider changes, and failure recovery.
- [ ] Test Hooks: discovery, enablement, matcher behavior, timeout, cancellation,
  output routing, failure, and compatibility fixtures.
- [ ] Test Plugins: discovery, review, activation, update, rollback, restart,
  capabilities, leases, and residue cleanup.
- [ ] Test Skills: discovery, source trust, enablement, refresh, policy, session
  projection, and compaction behavior.
- [ ] Test Connections: MCP discovery, enablement, per-tool overrides, OAuth,
  revocation, reconnect, and catalog changes.
- [ ] Test diagnostics, reset, import, export, backup, recovery, and invalid input.

### Concurrency and host consistency

- [ ] Test concurrent CLI, browser, runtime, and process writers with stale
  revisions and interrupted writes.
- [ ] Verify that every surface observes the same effective value, provenance,
  redaction, and application timing.
- [ ] Run native and Pi-adapter conformance for shared settings without introducing
  a native dependency on Pi.
- [ ] Test packed browser security, accessibility, responsive layout, no-store
  behavior, action tokens, rollback, and recovery.

Acceptance gate:

- One registry owns every public setting and no direct writer remains.
- Models, Hooks, Plugins, Skills, Connections, diagnostics, reset, import, export,
  backup, and recovery pass through CLI, browser, and runtime paths.
- Concurrent writers settle through revisions without lost updates or partial
  configuration.
- Native and supported adapter projections agree on shared configuration semantics.

## Execution order

Complete the workstreams in this order:

1. Terminal UX polish, because it defines the observable state required by later
   end-to-end scenarios.
2. Workers and orchestration. Durability and security tests need settled worker
   lifecycle semantics.
3. Durability. Security and configuration recovery rely on stable storage and
   replay behavior.
4. Security. The zero-bypass and rollback matrices depend on completed execution
   and durability boundaries.
5. Configuration, followed by the full cross-surface and packed-install matrix.

Workstreams can prepare independent fixtures in parallel, but a later acceptance
gate cannot compensate for an earlier failed gate.

## Release gate

Run focused tests during development. Before changing the release decision, run
all of the following from a clean commit:

```bash
yarn workspace octocode-agent verify
yarn verify
cargo test --manifest-path packages/octocode-agent-core-rust/Cargo.toml
```

The final release record must also contain:

- Packed-install results for every supported operating system and architecture.
- Credentialed provider and MCP results. These results must include cancellation
  and fault cases.
- Assistive-technology and keyboard-only terminal results.
- Durability, zero-bypass, secret-leak, configuration, and rollback matrices.
- Canary thresholds, owners, stop conditions, observation duration, and outcome.

Keep the decision at `HOLD` until every checkbox and acceptance gate is complete.
