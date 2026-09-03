# Workflow design

This document defines end-to-end operator workflows for the native Octocode Agent.
It explains how prompts, plans, research, tools, workers, interactions, sessions,
and recovery compose without inventing hidden modes. Widget behavior lives in
[the widget reference](WIDGETS.md); unfinished acceptance work lives in
[the completion plan](LEFTOVERS.md).

## Workflow model

Every workflow follows the same observable sequence:

```text
Trigger → Orient → Contract → Execute → Observe → Settle → Report
                    ↘ Clarify / Approve ↗       ↘ Recover
```

| Phase | Contract |
|---|---|
| Trigger | Accept a prompt, command, protocol request, schedule, or resumed action |
| Orient | Load authoritative session, workspace, trust, model, context, plan, and capability state |
| Contract | Decide the goal, constraints, effects, required approval, verification, and completion condition |
| Execute | Admit bounded model, tool, MCP, worker, hook, plugin, or automation effects |
| Observe | Project safe messages, progress, questions, context usage, and required actions |
| Settle | Commit success, failure, cancellation, blocked, or uncertain outcomes exactly once |
| Report | State the outcome, evidence, remaining risk, and next safe action |
| Recover | Resume only committed state and fence ambiguous effects from automatic replay |

The runtime can overlap admitted work, but it preserves model-call order and typed
settlement. Permission modes affect promptable approval only; they don't bypass
schema, trust, managed policy, plan rules, lock rules, capability ceilings, mandatory
approval, or the effect ledger.

## Choose a workflow

| Intent | Primary workflow | Plan requirement | Expected completion |
|---|---|---|---|
| Ask or explain | Ask | Optional | Evidence-backed answer |
| Resolve missing product input | Structured Ask | No | Accepted answers, Discuss handoff, cancellation, or timeout |
| Organize consequential work | Plan | Required | Approved, revisioned steps with checks |
| Change implementation | Implement | Recommended for multi-step work | Verified source change and concise handoff |
| Diagnose a supported failure | Root-cause analysis | Optional; recommended when broad | Causal mechanism, trigger, violated contract, and regression evidence |
| Review a change | Review | Optional | Ranked findings or explicit no-findings result |
| Parallelize independent work | Worker orchestration | Required when work has dependencies | Settled workers, integrated result, and cleanup |
| Continue prior work | Resume or switch session | Existing session state | Rehydrated visible history and retained model context |

Ask, Plan, and root-cause analysis are workflow names in this document. Ask is also
represented by normal prompt submission and the native `askUser` tool. Plan is a
native revisioned tool. Root-cause analysis is not a slash command or hidden runtime
mode; it is an investigative method composed from the normal runtime capabilities.

## Ask workflow

Use Ask for explanation, lookup, status, comparison, or a bounded request that
doesn't require repository mutation.

```text
Prompt → session/trust/context snapshot → model request
       → optional read-only tools or clarification
       → safe streamed answer → usage update → terminal receipt
```

Required behavior:

- Echo the submitted prompt as an operator message once.
- Show a safe phase such as `Thinking…` without exposing reasoning payloads.
- Use tools when facts need evidence; keep tool progress separate from prose.
- Ask only when available state cannot supply the information safely.
- Mark interrupted or failed assistant output explicitly.
- Finish with the answer. Then give supporting evidence and state relevant
  uncertainty.

The workflow completes when the answer satisfies the request or reports one precise
blocker and the next action needed to continue.

## Structured Ask workflow

The native `askUser` tool supports one question or a bounded sequence of Confirm,
Select, Prompt input, and Editor interactions.

For a sequence, the runtime supplies a workflow identity, stable question identity,
zero-based position, total count, optional title, optional instructions, and Discuss
availability. The action plane presents one question at a time.

Possible outcomes are:

| Outcome | Meaning |
|---|---|
| accepted | Preserve the validated answer and continue |
| discuss | Return collected answers and the unanswered question identities to the model |
| cancelled | Stop without inventing an answer |
| timeout | Stop because the interaction deadline elapsed |
| unsupported | Stop because the renderer or returned value violates the contract |

Discuss is an explicit branch. It lets the operator add context before the model
continues or asks a revised question.

## Plan workflow

Use Plan when work has multiple dependent steps, meaningful risk, parallel lanes,
or explicit review and approval.

```text
Scope → propose or clarify → operator decision → approved revision
      → start bounded steps → execute and verify → complete or reopen
      → review → final receipt
```

The native plan tool supports set, propose, clarify, add, edit, reorder, dependency,
approve, reject, change request, start, complete, reopen, remove, clear, show, and
review operations.

Plan invariants:

- Scope every plan to one session and workspace.
- Use stable plan and step identities with revision preconditions.
- Preserve explicit dependencies and allow no more than four active steps.
- Require approval before executing a proposed plan.
- Attach verification receipts only to the step and revision they prove.
- Invalidate affected receipts when dependencies or completed work change.
- Reject stale revisions, unknown identities, cycles, and invalid phase changes.
- Keep `/plan show` observational. Mutations go through the plan tool and typed
  interactions.

A plan completes only when every required step settles, required checks have valid
receipts, and review accepts the resulting revision.

## Implement workflow

Use Implement when the request authorizes source or configuration changes.

```text
Desired behavior → owning boundary → failing test → smallest implementation
                 → focused check → package check → real path → handoff
```

Required behavior:

- Inspect the owning architecture before changing a boundary.
- Preserve unrelated work in a dirty tree.
- Put semantic behavior in the owning package and operating-system behavior behind
  the injected native port.
- Add or update a failing test before implementation when the contract is new or
  broken.
- Verify in proportion to risk and exercise the built CLI, persistence, protocol,
  worker, or UI path when affected.
- Report changed files, observed checks, and residual limitations without claiming
  publication or deployment that did not occur.

## Root-cause analysis workflow

Use root-cause analysis for a supported behavior that fails under specific
conditions. Do not use the term root cause for a feature request or an unverified
symptom.

```text
Reproduce → contract → competing hypotheses → divergence boundary
          → mechanism and trigger → disconfirm alternate → regression test
          → cause and repair options
```

The workflow must establish all of the following:

- Actual behavior and a supported expected contract.
- A reproducible trigger or equivalent deterministic evidence.
- The first boundary where behavior diverges.
- A causal mechanism that explains the observed result.
- At least one plausible alternate that stronger evidence disproves.
- A regression test or sensor that fails before the repair and passes after it.

Research tools can locate structure and exact content; graph and language semantics
can prove connections; runtime tests can prove dynamic behavior. A search hit alone
is not causal evidence.

The report leads with the cause, affected behavior, and confidence. It separates the
diagnosis from repair authorization. If the request authorizes only diagnosis, the
workflow stops before changing source.

## Review workflow

Use Review to evaluate a diff, branch, package boundary, security surface, or
completed plan.

- Start from changed behavior, not file count.
- Trace affected consumers and tests.
- Rank actionable findings by impact and confidence.
- Give each finding an exact path anchor, mechanism, consequence, and smallest safe
  correction.
- State explicitly when no actionable finding survives verification.
- Keep style preferences separate from correctness, security, data loss, and
  compatibility findings.

Review does not authorize source edits unless the request also asks for fixes.

## Tool and MCP workflow

Every tool call follows this order:

```text
Validate schema → evaluate input-sensitive policy → resolve trust and approval
→ admit effect → execute within bounds → settle effect → project result
```

The transcript shows progress and a bounded outcome. It also shows a human label and
a sanitized action or target. Base tools, Octocode research, MCP calls, and Skills
retain separate effect and provenance contracts even when they share one card design.

MCP adds negotiated discovery, connection reuse, global concurrency, per-server
concurrency, Tasks, elicitation, cancellation, and provenance. Connection recovery
must not replay a call that might have committed.

## Approval workflow

Approval is a required action, not a notification.

```text
Candidate action → policy decision → approval card → allow, deny, discuss, or cancel
                 → effect admission only after an allowed decision
```

The card states the exact safe action, target, consequence, reason for review,
available decisions, and safe default. A denied, cancelled, timed-out, stale, or
unsupported interaction never admits the effect.

## Worker orchestration workflow

Use workers only for independent lanes with clear inputs, outputs, ownership, and
integration criteria.

```text
Root scopes work → optional plan ownership → spawn bounded leaf workers
→ observe progress and messages → steer or follow up → wait and seal
→ integrate evidence → verify root result → clean processes and worktrees
```

Only the root creates workers. Children remain depth-one leaves and never receive
worker-creation capability. Worker commands carry stable identity and the visible
inbox generation. Stale, cross-session, or ownership-mismatched commands fail
without changing worker state.

Graceful cancellation precedes force termination. Force termination is a separate,
approval-gated effect. A workflow isn't complete until every worker, lease, and
process settles. Each worktree and temporary resource must also settle or have an
explicit retained owner.

## Session workflows

### Start

Create one durable session unless `--no-session` selects in-memory operation. Show
the session receipt after the runtime commits it.

### Resume

Load committed session state, visible messages, retained model context, context
artifacts, plan state, effects, and supported worker communication state. Visible
history and retained model context remain separate after compaction.

### Switch

Replace the transcript and session-scoped projections instead of appending the new
session to the old view. Clear stale status and notifications tied to the previous
session.

### Fork

Create a new lineage node from committed source state. Do not copy uncertain effects
as replayable work.

Completion requires session receipts to include the display name, short public
identity, restored visible-message count, retained model-context count, context
occupancy, and compaction state. This completion item remains tracked in
[the completion plan](LEFTOVERS.md).

## Compaction workflow

```text
Threshold or command → freeze candidate context → create bounded summary projection
→ validate artifacts and references → commit compaction → replace live model context
→ update context and transcript receipts
```

The durable commit occurs before live context changes. Cancellation or failure keeps
the previous committed context. Resume reconstructs only committed state. Generated
summaries and memory remain inspectable data and never become hidden instructions.

## Cancellation and recovery

Cancellation targets the active interaction before the active turn. The runtime
then propagates cancellation through admitted tools, MCP Tasks, workers, provider
requests, and process supervision as supported.

Every interrupted operation settles as cancelled, failed, blocked, or uncertain.
The UI must not leave it visually active. On renderer or process failure, cleanup
restores terminal modes and releases owned listeners, timers, processes, leases,
temporary files, and worktrees.

Recovery rules:

- Replay committed state, not assumptions about attempted work.
- Fence crash-left started effects as uncertain.
- Preserve message and model-call order.
- Reject stale revisions and generations.
- Provide the next safe action without exposing private payloads.

## Settings workflow

Settings reads can occur through CLI, runtime, or the protected browser surface.
Mutations go through one revisioned, atomic, redacted registry.

```text
Read effective state → edit validated value → check revision and policy
→ atomic commit → sanitized projection → apply at declared lifecycle boundary
```

Each setting declares whether it applies immediately, on the next turn, on the next
session, or after restart. Concurrent writers use revision preconditions; a stale
writer receives a conflict instead of overwriting newer state.

## Workflow verification

Each workflow needs evidence across these dimensions:

| Dimension | Required evidence |
|---|---|
| Entry | Prompt, slash command, tool call, protocol request, resume, or schedule |
| State | Initial state, transitions, terminal outcome, stale input, and restart |
| Policy | Schema, trust, approval, capability, effect admission, and settlement |
| Presentation | Transcript, Activity, action plane, footer, and alternate output |
| Failure | Validation, denial, cancellation, timeout, provider fault, process fault, and cleanup |
| Persistence | Commit, replay, migration, compaction, and uncertain-effect fencing |
| Accessibility | Keyboard-only path, explicit labels, announcement order, and screen-reader task result |

The package and root release gates remain necessary but not sufficient. Credentialed
provider and MCP scenarios, multi-process workers, durability faults, security
matrices, supported-platform PTY runs, assistive technology, and rollback evidence
must also satisfy [the completion plan](LEFTOVERS.md).
