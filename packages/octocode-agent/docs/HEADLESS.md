# Headless runtime

Use the native launcher in headless mode for a one-shot run or a long-lived JSONL
controller. Headless modes don't initialize OpenTUI.

## Run once

Pass a prompt as an argument or through standard input:

```bash
octocode-agent run "Inspect the failing tests"
printf '%s\n' "Inspect the failing tests" | octocode-agent run
octocode-agent run --json "Inspect the failing tests"
octocode-agent run --model openai/gpt-5 "Inspect the failing tests"
octocode-agent run --model primary/model --fallback-model backup/model "Inspect the failing tests"
octocode-agent run --permissions strict "Inspect without unattended elevated work"
```

Text mode writes only assistant text to standard output. JSON mode writes one
versioned runtime-event envelope per line. Both modes return a nonzero status for
runtime failures, terminal turn errors, and turn timeouts. An empty terminal
invocation fails before the runtime or model starts.

`--permissions` selects the core human-in-the-loop policy. `strict` prompts for
promptable elevated work, `default` follows the tool declaration, and trusted
`allow-all` skips only promptable review. `allow-all` does not bypass mandatory
approval, workspace trust, managed policy, plan or lock rules, capability ceilings,
schema validation, or effect receipts. A headless run has no interactive reviewer,
so required review is denied rather than guessed.

`--model provider/model` is a process-local override. Fallback is deliberately
opt-in: each repeated `--fallback-model provider/model` extends an ordered chain,
the primary and fallbacks are health-probed before runtime creation, and execution
uses the first passing candidate. No passing candidate means no session turn is
started. Without a fallback flag, normal provider error and retry semantics are
unchanged and the launcher never switches vendors.

Headless modes own `SIGINT` and `SIGTERM` while work is active. The first signal
cancels the runtime, closes controller input when applicable, stops the runtime
exactly once, and removes both signal handlers. Cleanup has a 1-second bound so a
non-cooperative dependency can't retain process ownership. `SIGINT` returns 130;
`SIGTERM` returns 143.

JSON and RPC expose the public runtime-event projection. Internal
`context.preparing.messages` content, including system and repository instructions,
is replaced with a message count before serialization.
`context.artifacts-projected` exposes only projection phase, counts, budget, and
digests. It never exposes artifact IDs, prompt text, plans, skills, memory, tool
summaries, or compaction summary bodies.

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
input to close. Each UTF-8 JSONL input frame is limited to 1 MiB; an oversized
frame receives a typed validation error, is discarded without parsing, and does
not prevent a following valid frame from running. Buffered RPC output is also
limited to 1 MiB. If a consumer stops reading and the queue reaches that limit,
the transport reports a redacted overflow error and tears down deterministically.
Close standard input to drain pending commands and stop the runtime.

## Prompt and cache behavior

Every native session starts with the shared Octocode policy, the stable Awareness
policy, and applicable repository instructions. The
launcher reads `AGENTS.md`, or `CLAUDE.md` as a fallback, from the repository root
through the working directory. Outer instructions precede more-specific ones.
Live coordination does not come from that static prompt fragment. The native
session consumes validated Awareness events from the shared SQLite store and
projects accepted context into the running session.

This is the native product prompt path. The Pi adapter has a separate host-specific
prompt composition used only by supported Pi sessions and parity comparison; it is not
a launcher fallback.

The stable policy, instruction prefix, and deterministically sorted tool catalog
precede changing conversation content. This layout allows provider-side prefix
caching. The official Responses adapter reports `cachedInputTokens` and
`cacheWriteInputTokens` when OpenAI supplies those fields. The Chat Completions
adapter reports cache reads when a compatible provider supplies them; neither
adapter invents unavailable usage.

Core context artifacts classify additional material as `stable`, `epoch`, `dynamic`,
or `never-cache`. Stable and epoch blocks always precede live plans, skills, memory
leads, semantic evidence, and tool-result summaries. Each artifact has provenance,
freshness, retention, rehydration, visibility, and a SHA-256 digest; invalid,
superseded, unresolved, or over-budget artifacts are dropped with a receipt. Generated
summaries and memory are escaped, inspectable data and never gain instruction authority.
The native launcher reassembles live plan, skill, memory-lead, tool-summary, and
committed-compaction artifacts for initial context and every compaction. An initial
receipt emits after runtime startup; a compaction receipt emits only after the
durable projection is validated and installed as live context.

`/status` reports cumulative input, output, cache-read, and cache-write tokens when
the selected protocol supplies them. These are provider token counters, not a claim
about current context-window occupancy or local response caching.

The native launcher selects Responses for the canonical `api.openai.com` provider.
Custom providers declare `openai-responses`, `openai-completions`, or
`anthropic-messages` in a discovered `models.json` file. Model, endpoint, and protocol
environment variables don't create catalog entries; environment variables are reserved
for referenced credentials. Other native wire
protocols are not executable merely because discovery finds a model definition.

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

The native model receives one `octocode` research facade; the native `file`,
`bash`, `web`, and `runFfmpeg` base tools; and the `plan`, `awareness`, `skill`,
`MCPTool`, and `askUser` facades. `octocode` lists compact catalog metadata,
returns one exact underlying schema on demand, runs one validated call, or runs
1–8 independent calls with at most four active. Delegated workers retain the
same compact facade, filtered to their allowed catalog capabilities. The runtime validates every model tool envelope,
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

Native base tools apply these boundaries:

| Tool | Behavior | Trust and approval |
|---|---|---|
| `file` | Reads bounded workspace text; writes and edits use explicit SHA-256 preconditions and atomic replacement; delete rechecks the same precondition. Lexical and symbolic-link escapes fail. | Reads need no approval. Write and edit require workspace trust and on-request write approval. Delete also declares a destructive effect. |
| `bash` | Runs one bounded shell command in the workspace, filters secret-like inherited environment variables, caps output, and supports cancellation with a bounded timeout. | Every call conservatively declares read, write, network, and process effects, requires workspace trust and on-request approval, and is forbidden in plan mode. |
| `web` | Fetches public HTTP and HTTPS content or searches the public web with DNS and redirect revalidation, response bounds, and private-address blocking. | Declares a network effect, needs neither workspace trust nor approval, and allows at most four active calls. |
| `runFfmpeg` | Runs `ffmpeg` or `ffprobe` without a shell. File operands must be declared as exact `{{input:N}}` or `{{output:N}}` arguments. Rust authorizes each contained regular input or prospective output; TypeScript owns argv roles, binary discovery, process groups, stream bounds, progress, timeout, cancellation, and result encoding. Protocol and device inputs fail closed. | Reads declare read/process; outputs add write. Calls require workspace trust and on-request approval, are forbidden in plan mode, and use one dedicated process lane. |

The default native direct registry is `octocode`, `plan`, `awareness`, `web`,
`bash`, `file`, `runFfmpeg`, `skill`, and `MCPTool`. The launcher adds `askUser`.
A trusted root may add `worker`; children are leaves and never receive it.
Reviewed API plugins can add namespaced custom tools. `octocode` is the compact
facade over the indirect 15-tool research catalog; `awareness` owns memory, lock,
message, verification, and coordination actions. These consolidations are
intentional, so the native palette does not duplicate Pi's `callTool`, `memory`,
`lock`, or `message` names.

Pi-only higher-level media names (`readMedia` and `media`) and host helpers
(`chromeDebug` and `localServer`) are not advertised as native core tools. Their
absence is a capability difference, not an inert registration. Use `runFfmpeg`
for bounded native media processing and a reviewed plugin for host-specific
browser or server behavior.

The `skill` facade supports `list`, `load`, and `read`. `load` returns the reviewed
instructions and supporting-file inventory. `read` loads a bounded text file
inside that skill directory. Skill metadata such as `allowed-tools` is
descriptive and never grants permission. Scripts run only through a separately
authorized process tool.

`MCPTool` supports tools, resources, prompts, completion, Tasks, and a bounded
`parallel-call` action for explicitly
configured stdio or Streamable HTTP servers. It validates tool arguments against
the server schema, keeps referenced secrets out of status output, confines stdio
working directories to the workspace, and reuses one client per configured server
until runtime shutdown. Concurrent shutdown callers share one close barrier.
Resource and prompt lists follow bounded pagination. Approval prompts identify
the MCP server and operation without exposing arguments or referenced secrets.
Read actions, including status, capabilities, discovery, resources, prompts,
completion, and task reads, don't declare a write effect or request mutation
approval. Tool calls, `parallel-call`, and task cancellation fail closed behind
workspace trust and approval. `parallel-call` accepts one through eight calls,
keeps results in input order, admits at most four calls globally, and respects
each server's `maxConcurrentCalls` value from one through four.

Task actions are `task-get`, `task-list`, `task-result`, and `task-cancel`. They
send the official negotiated `tasks/*` requests with the MCP SDK's matching result
schemas; they do not rely on optional client convenience methods. `task-list`
preserves the server cursor as an opaque value. Listing and cancellation fail
closed unless the server advertises those individual task capabilities.

Durable MCP task state uses strict versioned records and a cross-process
transaction. Writes take a bounded lock, recover stale locks, use private
temporary files, synchronize data before atomic replacement, and fail closed on
corrupt or unsupported records. A failed read never overwrites the original
record.

## Durable automations

Installed builds run the session-owned automation scheduler over the packaged
Rust actor. Rust atomically stores definitions and unique logical runs, performs
revision compare-and-swap, leases claims with opaque fencing tokens, rejects
stale heartbeats and settlements, and makes expired claims reclaimable. The
TypeScript scheduler expands `once`, `interval`, and `cron` schedules, applies
`skip`, `run-once`, or bounded `catch-up` misfire behavior, heartbeats active
claims, and applies the definition's retry policy. It dispatches only registered
semantic action names and versions; durable payloads never become arbitrary code.

Interactive sessions expose `/automations list`, `/automations run <id>`, and
`/automations cancel <id> <revision>`. The installed launcher registers only
the `awareness.status@1` semantic executor. There is no top-level
`octocode-agent automations` command. Cancellation uses the listed revision and
fails on stale state. A run that might have produced an external effect but
cannot prove its outcome settles as `uncertain` and is not replayed as success.

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

Installed builds persist sessions through the packaged Rust SQLite actor. Session
append and project, parent, and navigation index updates commit in one
transaction. Effects use atomic admission and terminal settlement; a crash-left
`started` effect becomes `uncertain` before replay and never executes again.
Missing sessions fail resume and fork instead of becoming revision-zero records.
`--no-session` uses the in-memory store and does not start durable automations.

See the cross-host [capability discovery guide](../../../docs/DISCOVERY.md) for source
locations. That guide keeps Pi catalog and UI mechanics explicitly scoped to the parity
oracle.

## Verification

The implementation receipt and remaining limitations are recorded in the
[headless runtime evaluation](../../../DESIGN/pi-coding-agent-removal/evidence/headless-runtime-eval-2026-08-28.md).
