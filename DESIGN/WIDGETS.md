# Widget design

This document defines the semantic widget system for the native Octocode Agent
terminal. It is a reference for product behavior, implementation ownership, state,
interaction, accessibility, and verification. The
[terminal design system](../packages/octocode-agent/docs/TERMINAL_DESIGN_SYSTEM.md)
owns shared visual semantics; this document owns widget composition and boundaries.

## Design rules

Every widget must satisfy these rules:

- Accept typed, bounded, runtime-authoritative state.
- Render meaning through words and markers in addition to color.
- Keep visual output and alternate output semantically equivalent.
- Strip terminal controls, redact recognizable credentials, and truncate at
  grapheme boundaries.
- Reject stale revisions, identity drift, invalid state transitions, and ambiguous
  payloads instead of repairing them silently.
- Expose only actions backed by the canonical keymap or a typed controller intent.
- Keep hidden chain-of-thought, provider reasoning payloads, private worker prompts,
  raw tool arguments, and internal process details out of every output path.
- Preserve the composer and required action at every supported terminal size.

Widget source belongs under
[`src/terminal/opentui/widgets/`](../packages/octocode-agent/src/terminal/opentui/widgets/).
The renderer owns shell placement, the widget controller owns materialization, and
the presentation contracts own runtime-to-renderer data.

## Terminal composition

The shell uses the following semantic regions in priority order:

| Region | Purpose | Space policy |
|---|---|---|
| Header | Runtime identity, trust, model, session, and working state | Collapse low-priority identity before high-priority state |
| Conversation | Messages, safe thinking phase, and tool cards | Receives the largest available viewport |
| Activity and Context rail | Operational history, plans, workers, and context details | Visible on wide layouts; reachable as a compact pane on narrow layouts |
| Action plane | Confirmation, selection, text input, or editing | Displaces informational content while an action requires input |
| Composer | Prompt entry, attachments, commands, and completion | Remains visible while the runtime accepts input |
| Footer | Mode, connection, context occupancy, lifecycle summary, and keys | Retains critical state and progressively drops low-priority hints |

Only one action-plane widget is active at a time. Read-only widgets can coexist,
but the controller must preserve one deterministic focus owner.

## Widget catalog

| Widget | Source owner | Authority | Primary states | Direct actions |
|---|---|---|---|---|
| Header | `widgets/header.ts` | Runtime chrome snapshot | idle, active, cancelling, failed | None |
| Transcript | `widgets/transcript.ts` | Presentation messages | streaming, complete, cancelled, error | Scroll |
| Tool progress | `widgets/tool-progress.ts` | Tool lifecycle | pending, running, success, blocked, cancelled, error | Expand or collapse bounded details |
| Worker progress | `widgets/worker-progress.ts` | Worker lifecycle | `queued`, `running`, `succeeded`, `failed`, `aborted`, `killed` | None |
| Worker operations | `widgets/worker-operations.ts` | Generation-fenced inbox | read-only snapshot and selected operation | Inspect, send, follow-up, steer, `abort`, or request kill |
| Plan | `widgets/plan.ts` | Runtime plan snapshot | empty, draft, approved, active, complete | Scroll only |
| Status and notifications | `widgets/status-notifications.ts` | Typed status slots and notifications | info, success, warning, error | Invoke an attached typed action when present |
| Presentation surface | `widgets/presentation-surface.ts` | Runtime presentation command | text, list, key-value, progress | Scroll only |
| Confirm | `widgets/confirm.ts` | Interaction request | pending, accepted, discuss, cancelled, timeout | Choose an allowed result |
| Select | `widgets/select.ts` | Interaction request | pending, accepted, discuss, cancelled, timeout | Navigate and choose one option |
| Prompt input | `widgets/prompt-input.ts` | Interaction request | editing, valid, invalid, submitted, cancelled | Enter and submit one value |
| Editor | `widgets/editor.ts` | Interaction request | editing, valid, invalid, submitted, cancelled | Edit, select, undo, redo, submit, or cancel |
| Composer assist | `widgets/composer-assist.ts` | Composer catalog | inactive, command completion, file completion | Navigate and apply a suggestion |
| Footer | `widgets/footer.ts` | Runtime facts and canonical keymap | connection and context thresholds | None |

`widgets/base.ts`, `widgets/contracts.ts`, `widgets/layout.ts`,
`widgets/sanitize.ts`, and `widgets/registry.ts` are infrastructure. They don't own
operator-facing product state.

## Header

The header is a stable, read-only runtime receipt.

- Show the product title, working state, trust, model, and session only when the
  runtime supplies them.
- Announce material session, model, and trust changes. Resizing and ordinary
  working-state updates remain quiet.
- On narrow layouts, omit session identity before model identity. Preserve trust
  and working state.
- Never derive trust, model, or session identity from assistant text or tool output.

## Transcript

The transcript owns chronological system, operator, assistant, and tool messages.

- Render text segments and a safe phase such as `Thinking…`; never render the
  contents of a thinking segment.
- Mark assistant terminal outcomes with explicit `Failed` or `Cancelled` labels.
- Keep stable message and turn identities so streaming deltas update one record.
- Announce bounded streaming updates politely and terminal outcomes immediately.
- Route detailed tool execution to tool-progress cards instead of duplicating raw
  results in message prose.

Session switching replaces transcript state. Resume after compaction restores
committed visible messages separately from retained model context.

## Tool progress

One tool call maps to one stable tool-progress widget.

- Use a readable public label and a sanitized target or action summary.
- Show progress counts only when both current and total values are authoritative.
- Accept the first terminal state as final and reject contradictory settlement.
- Classify outcomes as result, validation, permission, policy, timeout, cancelled,
  or system failure.
- Expand only bounded input and outcome summaries. Expansion never exposes the raw
  argument object or provider payload.

The humanization layer maps native tools to Files, Terminal, Web, Media, and Code
research. MCP and Skill calls follow the same bounded-summary contract.

## Workers

Worker progress and worker operations are separate widgets.

Worker progress shows runtime-authoritative identity, optional agent type, public
state, bounded concurrency counts, and elapsed time. It doesn't show prompts,
capabilities, process arguments, handback payloads, or private failure details.

Worker operations opens from a generation-fenced inbox snapshot. Every operation
includes the visible generation and stable worker identity. Graceful cancellation
and force termination remain distinct; force termination requires explicit approval.

## Plan

The Plan widget is an observational view of one authoritative plan snapshot.

- Preserve plan identity, session/workspace scope, revision, phase, step order,
  dependencies, worker ownership, checks, and verification receipts.
- Mark active work and blockers with words and symbols rather than color alone.
- Never infer approval, completion, verification, or dependency satisfaction.
- Reject stale revisions, duplicate step identities, unknown dependencies, scope
  drift, and more than four concurrent active steps.
- Keep mutation in the native plan tool and interaction flow. The widget scrolls
  but doesn't edit plan state.

## Status, notifications, and footer

Status slots represent replaceable lifecycle state. Notifications represent
bounded transitions or outcomes. The footer represents persistent facts and the
highest-priority active lifecycle summary.

When operations overlap, the footer prioritizes compaction, session transition,
resource discovery, trust resolution, and provider request in that order. Activity
retains detail; the footer must not become an event log.

Repeated notifications need deterministic coalescing keys. Coalescing can replace
intermediate progress, but it must preserve the first transition, latest progress,
terminal result, failure, and required action. The
[completion plan](LEFTOVERS.md) tracks this work.

## Generic presentation surface

The generic presentation surface renders runtime-owned text, list, key-value, or
numeric progress content when no specialized widget owns the semantics.

Do not use it for conversation, tools, plans, workers, approvals, questions, or
editable content. Use a specialized widget when state transitions or actions carry
product meaning.

## Interaction widgets

Confirm, Select, Prompt input, and Editor implement the action plane. Each request
can carry a bounded workflow identity, question identity, position, total, title,
instructions, and Discuss availability.

- Confirm returns a boolean decision or a non-accepted terminal status.
- Select returns one declared option.
- Prompt input returns one bounded value.
- Editor returns bounded multiline text and owns cursor, selection, undo, redo,
  validation, and scrolling.
- Discuss returns control without inventing an answer and preserves answers already
  collected by a structured Ask workflow.
- Cancel, timeout, and unsupported are distinct outcomes.

Sensitive input remains unavailable until the transport proves masking across the
visual surface, alternate output, transcript, history, diagnostics, and restoration.

## Composer

The composer accepts normal prompts, slash commands, workspace file references,
multiline paste, and supported image attachments.

- `Enter` sends and `Shift+Enter` inserts a newline.
- Command and file completion can consume `Tab` only while completion is active.
- Multiline paste can render as a compact marker while retaining the complete text
  for submission.
- Image markers contain a bounded basename, media type, and size. Image bytes and
  workspace paths remain outside visible draft text.
- Invalid, escaped, unsupported, or oversized attachments remain visible as
  validation failures.

## Focus and responsive behavior

- `Tab` and `Shift+Tab` traverse the canonical focus order.
- `Esc` closes the active overlay or returns focus before interrupting work.
- Arrow keys act within the focused widget and never mutate another widget.
- Every pointer action has a keyboard equivalent.
- Wide layouts show conversation beside Activity and Context.
- Narrow layouts retain conversation, composer, action plane, footer, and a
  reachable Activity/Context pane.
- Short layouts collapse informational chrome before required actions or input.
- Alternate output preserves a complete sanitized reading order independent of
  visual clipping.

## Verification matrix

Every widget requires all of the following checks:

| Dimension | Required evidence |
|---|---|
| State | Initial, update, terminal, stale, duplicate, and invalid transitions |
| Content | Bounds, redaction, control stripping, grapheme handling, and empty values |
| Input | Focus, canonical keys, cancellation, validation, and unsupported input |
| Layout | Wide, narrow, short, resize, scroll preservation, and no horizontal dependency |
| Accessibility | Explicit labels, markers plus words, announcement deduplication, and alternate output |
| Lifecycle | Mount, update, replacement, unmount, renderer failure, and cleanup |
| Integration | Typed presentation event through controller, widget, renderer, and real PTY |

The release gate must also prove that widget failures restore terminal modes and
leave no child process, listener, timer, or temporary resource behind.
