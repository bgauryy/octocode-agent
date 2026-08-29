# ACP runtime

The native ACP v1 adapter serves the official Agent Client Protocol SDK over
standard input and standard output. Use it when an editor owns the interface
while Octocode owns the agent runtime.

## Session ownership

- Each ACP session owns one canonical native `AgentRuntime`.
- Session creation starts the runtime before returning the session ID.
- Prompts subscribe to runtime events before submitting text.
- Non-text prompt blocks fail with invalid parameters.
- Closing the adapter cancels every active prompt and stops every session runtime
  exactly once.

The adapter translates public message, status, tool, and plan events into ACP
session updates. It doesn't expose private runtime context.

## Cancellation and process signals

ACP `session/cancel`, connection shutdown, `SIGINT`, and `SIGTERM` cancel the
active prompt through the adapter-owned cancellation path. A process signal also
closes the protocol connection and removes both process handlers. Cleanup has a
1-second bound so a non-cooperative runtime can't retain process ownership.

The first process signal owns the outcome:

| Signal    | Process status | Runtime reason       |
| --------- | -------------: | -------------------- |
| `SIGINT`  |            130 | `user interrupt`     |
| `SIGTERM` |            143 | `process terminated` |

Repeated close calls share one promise. They don't cancel or stop a runtime more
than once.

## Stop reasons

ACP v1 has no timeout stop reason. A native turn timeout maps to
`max_turn_requests`, the closest supported non-success value because both mean
the turn ended after exhausting a runtime-owned bound. A client or process
cancellation maps to `cancelled`; it never maps to `end_turn`.

See [Headless runtime](HEADLESS.md) for JSONL framing, output redaction, and the
other noninteractive modes.
