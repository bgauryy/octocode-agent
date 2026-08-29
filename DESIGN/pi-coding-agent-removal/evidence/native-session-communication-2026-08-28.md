# Native session communication receipt — 2026-08-28

Status: dirty-tree implementation evidence; not a release or cutover receipt.

## Goal and acceptance sensor

Goal: route addressed session/subagent messages into the native runtime through
the existing Awareness transaction outbox, without a second mailbox authority or
dynamic base-prompt mutation.

Primary KPI: 100% of valid targeted peer events are persisted before ordered
acknowledgement and become model-visible exactly once. Guardrails: proposals are
held; wrong-target, expired, forged, and non-peer events are refused; failed
delivery does not advance the cursor; concurrent drains do not duplicate work.

Baseline: Awareness already provided the SQLite outbox, per-consumer cursors,
ordered acknowledgement, and peer inbound policy, but only the Pi harness
consumed it. The native/headless runtime had no inbound outbox bridge.

## Implemented flow

```text
subagent/session sendMessage
  -> Awareness SQLite event_outbox (peer.message)
  -> shared bounded serialized consumer
  -> target/provenance/expiry policy
  -> native context.append(eventId, authority:data text)
  -> atomic session commit: model context + replay marker
  -> outbox acknowledge / consumer cursor advance
  -> next native model turn
```

The shared consumer now lives in `@octocodeai/octocode-awareness`; Pi retains
only its host adapter. Native sessions use `native-session:<sessionId>` cursor
identity and a separately resolved Awareness agent identity. `context.append`
does not change the stable base prompt. The runtime bounds peer context at 16 KiB,
tracks source event IDs, and restores those IDs from durable session markers.

If persistence fails, acknowledgement is withheld and strict ordering stops at
that event. If the process fails after session commit but before acknowledgement,
the replayed event is recognized by its durable marker and acknowledged without a
second model-context insertion.

## Verification

- Awareness suite: 117 files, 990 tests passed; coverage gate passed at 89.16%
  statements and 93.07% lines.
- Agent-core suite: 7 files, 72 tests passed.
- Pi extension suite: 124 files, 1,760 tests passed.
- Native agent suite: 48 files passed, one skipped; 395 tests passed and 16
  intentionally skipped.
- Root test run: 3,294 tests passed and 16 intentionally skipped after lint and
  typecheck passed.
- Focused real-SQLite bridge: a child handoff reached a native parent, advanced
  the durable cursor, and was not redelivered on the second drain.
- Focused persistence case: peer model context and its replay marker committed in
  one two-event session transaction with the same causation ID.
- Built RPC smoke: `runtime.ready` preceded the snapshot response, followed by
  `runtime.stopping` and `runtime.stopped` after EOF.

## Remaining boundary

This closes the native inbound session bus slice, not native orchestration as a
whole. A production native worker supervisor, spawn/wait/abort/kill lifecycle,
worker capability packets, broadcast policy, UI worker controls, and a true
two-process crash/lease corpus remain open. Release status therefore remains
**HOLD**.

Verdict: **ACCEPT** this communication increment; continue ORCH-001/002/003 and
the remaining ORCH-004 conformance work.
