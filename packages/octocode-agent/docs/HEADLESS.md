# Headless runtime

Use the native launcher in headless mode for one-shot automation or a long-lived
JSONL controller. Headless modes don't initialize OpenTUI.

## Run once

Pass a prompt as an argument or through standard input:

```bash
octocode-agent run "Inspect the failing tests"
printf '%s\n' "Inspect the failing tests" | octocode-agent run
octocode-agent run --json "Inspect the failing tests"
```

Text mode writes only assistant text to standard output. JSON mode writes one
versioned runtime-event envelope per line. Both modes return a nonzero status for
runtime failures, terminal turn errors, and turn timeouts. An empty terminal
invocation fails before the runtime or model starts.

Headless modes own `SIGINT` and `SIGTERM` while work is active. The first signal
cancels the runtime, closes controller input when applicable, stops the runtime
exactly once, and removes both signal handlers. Cleanup has a 1-second bound so a
non-cooperative dependency can't retain process ownership. `SIGINT` returns 130;
`SIGTERM` returns 143.

JSON and RPC expose the public runtime-event projection. Internal
`context.preparing.messages` content, including system and repository instructions,
is replaced with a message count before serialization.

## Control a runtime

Run `octocode-agent serve` for versioned JSONL RPC over standard input and
standard output. Requests contain `protocolVersion`, `requestId`, and a typed
runtime command. Responses preserve `requestId`; asynchronous runtime events use
an independent monotonically increasing `sequence`.

The controller dispatches commands concurrently. Steering interrupts only the
active provider attempt, then adds the steered input at the next model-safe
point within the same turn. It doesn't replay effects that already completed.
Follow-ups remain FIFO inputs for later turns. Runtime startup must complete
before request dispatch begins, so a startup failure exits without waiting for
input to close. Close standard input to drain pending commands and stop the
runtime.

## Prompt and cache behavior

Every native session starts with the shared Octocode policy, the canonical
Awareness coordination fragment, and applicable repository instructions. The
launcher reads `AGENTS.md`, or `CLAUDE.md` as a fallback, from the repository root
through the working directory. Outer instructions precede more-specific ones.

This is the native product prompt path. The Pi adapter has a separate host-specific
prompt composition used only by supported Pi sessions and parity comparison; it is not
a launcher fallback.

The stable policy, instruction prefix, and deterministically sorted tool catalog
precede changing conversation content. This layout allows provider-side prefix
caching. The official Responses adapter reports `cachedInputTokens` and
`cacheWriteInputTokens` when OpenAI supplies those fields. The Chat Completions
adapter reports cache reads when a compatible provider supplies them; neither
adapter invents unavailable usage.

The native launcher selects Responses for `api.openai.com`. Custom
OpenAI-compatible endpoints default to Chat Completions. Set
`OCTOCODE_MODEL_PROTOCOL` to `openai-responses` or
`openai-chat-completions` to select an adapter explicitly.

Run `octocode-agent acp` to serve ACP v1 over stdio for an editor. This route
uses the official ACP SDK, creates one canonical runtime per ACP session, and
shares the runtime's session, policy, tool, cancellation, and presentation
events. Non-text ACP prompt blocks fail closed until the native model contract
supports them. See the [ACP runtime reference](ACP.md) for lifecycle and stop
semantics.

Native Octocode catalog discovery uses `octocode tools --json --full` once and
keeps a bounded in-process cache. The cache is isolated by runner, workspace,
Octocode home, and every environment flag that changes the catalog, including
local, clone, release, and discussion tools. MCP tool catalogs follow pagination,
sort tools deterministically, and use a short per-runtime cache. Unknown tools
force one catalog refresh before failing.

## Tools, MCP, and skills

The native model receives the live Octocode schemas plus the `plan`, `skill`,
`MCPTool`, and `askUser` facades. The runtime validates every model tool envelope,
including combinators, local references, object, array, string, and numeric
constraints in the published JSON Schema. It applies trust, plan, approval, and
effect policy before execution, and correlates
each result with its tool-call ID. Each turn has bounded model iterations and
tool calls. Each serialized tool result has a byte limit, and the model-visible
results in one turn share an aggregate byte budget. A model batch that exceeds
the tool-call budget fails before any call in that batch executes.

The runtime admits each approved call through an injectable effect ledger before
execution. Reconstruction with the same session, logical turn, and call ID does
not replay a committed, failed, running, or uncertain effect. Cancellation has a
bounded terminal path even when an in-process tool ignores its abort signal; the
ledger records that effect as uncertain instead of claiming it stopped.

Tool policy uses a canonical non-empty effect set, so one call can declare several
capabilities. The admission receipt binds the exact input, effects, trust, approval,
plan revision, lock targets, and policy receipts. The native launcher persists that
receipt and rejects a repeated call whose receipt differs.

The `skill` facade supports `list`, `load`, and `read`. `load` returns the reviewed
instructions and supporting-file inventory. `read` loads a bounded text file
inside that skill directory. Skill metadata such as `allowed-tools` is
descriptive and never grants permission. Scripts run only through a separately
authorized process tool.

`MCPTool` supports tools, resources, prompts, and completion for explicitly
configured stdio or Streamable HTTP servers. It validates tool arguments against
the server schema, keeps referenced secrets out of status output, confines stdio
working directories to the workspace, and reuses one client per configured server
until runtime shutdown. Concurrent shutdown callers share one close barrier.
Resource and prompt lists follow bounded pagination. Approval prompts identify
the MCP server and operation without exposing arguments or referenced secrets.

Durable MCP task state uses strict versioned records and a cross-process
transaction. Writes take a bounded lock, recover stale locks, use private
temporary files, synchronize data before atomic replacement, and fail closed on
corrupt or unsupported records. A failed read never overwrites the original
record.

The native `plan` tool stores session-and-workspace-scoped plans with the same
closed-record and compare-and-swap rules. Runtime admission reads the canonical
plan file before each governed tool call, so a peer-process plan change doesn't
leave policy state stale. A checked step completes only from a matching receipt
created by a host-owned verifier; model-supplied receipts and arbitrary command
execution are rejected.

The external Octocode facade rejects malformed catalog versions, counts, duplicate
tools, non-JSON execution data, and schema-invalid outputs when an output schema is
published. Its production adapter still invokes `npx octocode`, and the upstream
catalog doesn't yet provide authoritative composite effects, lock-target semantics,
or every output schema. Treat that route as a guarded implementation candidate, not
as a completed tool-authority or release boundary.

## Failure and resume behavior

Provider HTTP and network failures use typed runtime categories. Retryable
statuses include retry metadata, including a bounded `Retry-After` value when the
provider supplies one; provider response bodies aren't exposed. Cancellation
after streaming starts is reported as cancellation instead of a provider error.
The runtime retries only failures marked safe, only within a finite attempt
budget, and only before an external effect has started in the logical turn. Each
failed attempt has its own message lifecycle, so partial deltas don't enter
durable history or the next attempt.

`/compact` uses the active provider without tools. The core service persists a
stable attempt ID, source revision, trigger, retry, or terminal state, summary,
source event IDs, retained event IDs, and projection version. It rejects unknown
retained IDs and leaves the previous usable context unchanged on failure or
cancellation. Resume deterministically fails an interrupted attempt before
starting another and reconstructs the committed summary-plus-retained context.

Durable session history doesn't keep partial assistant text from a cancelled or
failed turn. If a previous hard stop left an assistant tool call without a tool
result, resume inserts a synthetic cancelled result before the next model
request. This preserves tool-call correlation without replaying the effect.

Explicit resume and terminal continuation recover from a valid session backup
when the primary is missing or corrupt. New session and fork identities combine
a timestamp with a UUID, and fork repair remaps parent, branch, compaction, and
retained-event references before the destination becomes visible.

See the cross-host [capability discovery guide](../../../docs/DISCOVERY.md) for source
locations. That guide keeps Pi catalog and UI mechanics explicitly scoped to the parity
oracle.

## Verification

The implementation receipt and remaining limitations are recorded in the
[headless runtime evaluation](../../../DESIGN/pi-coding-agent-removal/evidence/headless-runtime-eval-2026-08-28.md).
