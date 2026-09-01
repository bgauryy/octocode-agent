# Parallel tools, MCP calls, and workers

This guide describes the bounded concurrency supported by the native agent. The
defaults are conservative: ordinary tool calls are serial, calls to one MCP
server are serial, and workers are disabled until the operator authorizes them.

## Run the native agent

Use command-scoped help for the mode you intend to run:

```bash
octocode-agent run --help
octocode-agent serve --help
octocode-agent acp --help
```

Options may precede the help flag. Use `--` when text that resembles an option
is the literal prompt, for example `octocode-agent run -- --help`.

Authorize native workers only in a trusted workspace:

```bash
octocode-agent --allow-workers
octocode-agent run --allow-workers "Split this review into independent workstreams and join every worker."
octocode-agent serve --allow-workers
```

`--allow-workers` preauthorizes bounded worker-process calls in a trusted
workspace; it does not force the model to delegate. Without it, each call still
needs an available interaction approval, so noninteractive modes normally deny
the call. Worker model and tool requests are still intersected with the parent's
available capabilities and normal trust and effect policy.

Worker capabilities have two independent scopes. `tools` selects model-visible
direct tools such as `octocode`, `file`, `bash`, `web`, `skill`, `MCPTool`,
`awareness`, and `plan`. Optional `octocodeTools` narrows the research operations
inside the `octocode` facade. Omitting `octocodeTools` keeps the parent's permitted
catalog; it does not remove the facade. The default leaf set contains every
available leaf-safe direct tool and never contains `worker`.

## Tool-call concurrency

Tool definitions are serial unless their policy returns an explicit concurrency
lane for the current input. The core admits policy and effect receipts in model
call order, runs each lane with its declared limit, and restores results to model
call order. A serial call is a barrier between parallel batches.

Adapters that expose an inner batch share one admission pool across every tool
invocation. Therefore, four concurrent `web` or `octocode` facade calls cannot
multiply four-wide inner batches into 16 operations. The `octocode` facade also
validates every selected inner schema before any executor starts. `file` validates
contained mutation lock targets, and `bash` repeats schema validation at its
execution boundary before spawning a process.

The limits are:

- one through four active calls per declared lane;
- four active tool calls globally;
- the lower limit when calls declare different limits for the same lane.

Cancellation settles calls that never started as `cancelled`. Calls that may
have begun an external effect retain the existing `uncertain` settlement. Invalid
lane metadata fails validation instead of silently enabling concurrency.

## Parallel MCP calls

Different MCP servers can overlap. Calls to the same server remain serial unless
that server explicitly sets `maxConcurrentCalls` from 1 through 4:

```json
{
  "mcpServers": {
    "search": {
      "command": "search-mcp",
      "maxConcurrentCalls": 2
    },
    "issues": {
      "command": "issues-mcp"
    }
  }
}
```

In this example, at most two `search` calls overlap, `issues` calls are serial,
and calls to `search` and `issues` can overlap subject to the global limit of
four. Connection setup remains deduplicated per server. A model can issue
separate `call` actions or one ordered `parallel-call` containing one through
eight calls. The batch uses at most four global permits, and each call also
acquires its server's permit. Read-only discovery actions don't request write
approval; calls, batches, and task cancellation do.

`parallel-call` resolves servers, discovers schemas, and validates every call
before it invokes any MCP tool. A malformed sibling therefore cannot race with a
valid side effect. Once preflight succeeds, execution failures remain per-call
results in input order.

### MCP discovery and catalog updates

Octocode is the MCP client. Configuration discovery only locates and validates
server definitions; it does not start foreign processes or network sessions.
Protocol discovery is explicit through the compact `MCPTool` surface:

- `status` reports configured servers and catalog state (`not-loaded`, `ready`,
  `stale`, or `empty`) without connecting.
- `discover` acquires the server lazily and returns its negotiated, bounded tool
  catalog; a still-valid cache is identified as `cached`.
- `refresh` forces a new paginated `tools/list` request and identifies the result
  as `discovered` or `updated`.

When a server negotiates `tools.listChanged`, its notification marks the cache
stale and emits a bounded semantic notification to JSON and terminal consumers.
The Settings control center shows the same live state, last refresh, count, and
bounded tool-name list. The next `discover` or `refresh` updates it. A transport close evicts only
that exact connection, so the next safe request reconnects. Octocode never
automatically replays a tool call or task cancellation after a connection loss.
Discovery and refresh emit bounded progress through the ordinary canonical tool
event stream, so JSON and terminal renderers observe the same operation. The
full catalog remains in the tool result; compact terminal summaries are views,
not data truncation.

## Root-only delegation

Only the root agent can create workers. Every child is a leaf:

```text
root (up to 4 active workers)
└── child (leaf; no worker tool or worker supervisor)
```

The root strips `worker` from delegated tools and never passes
`--allow-workers` to a child. Internal depth metadata is fixed at root depth zero
and child depth one. A child marker claiming depth zero, a maximum depth above
one, or a worker capability in a child packet fails closed.

Spawned workers remain open for `send`, `steer`, or `follow-up` while they are
running. Calling `wait` is the join boundary: it seals that worker's RPC input,
waits for runtime cleanup and process exit, and then returns the terminal
handback. Do not send more input after joining a worker.

Interactive management starts with `/workers list` (or `/octocode-inbox`). The
renderer-neutral inbox exposes only stable worker ID, canonical state, queue depth,
safe task/plan labels, available semantic actions, and a monotonic generation.
Every inspect or mutation command carries that displayed generation; stale actions
fail and instruct the user to refresh. `send`, `follow-up`, `steer`, and graceful
`abort` use the ordinary operations controller. Force `kill` is a separate action
that fails closed unless the host supplies and grants explicit force-kill approval.
The inbox projection never contains PIDs, prompts, capabilities, models, terminal
reasons, handback bodies, or hidden reasoning.

Spawn, read, wait, abort, and kill actions use a four-wide worker-control lane.
This lets a same-batch abort or kill interrupt a blocking wait. Message-producing
`send`, `steer`, and `follow-up` actions remain serial so the journal and child RPC
observe parent input in model-call order.

The external worker-command projection is also nonrecursive, so projected
packets cannot bypass the leaf-only capability checks.

## Durable worker messages with the packaged Rust core

The package build compiles the Rust actor and places it beside the built CLI.
Installed runs select that binary automatically; no environment variable is
required. It journals parent-to-worker prompts, sends, steers, follow-ups, and
cancellation reasons:

```bash
yarn workspace octocode-agent build
node packages/octocode-agent/out/octocode-agent.mjs run --allow-workers "Delegate one bounded task and wait for it."
```

For a development override, set `OCTOCODE_AGENT_RUST_CORE_BIN` or
`OCTOCODE_AGENT_RUST_CORE_DB` to an absolute path. The built CLI fails closed if
its packaged platform binary is missing.

The Vercel AI SDK `ai` package owns the validated `UIMessage` envelope and text
parts. It does not replace process RPC: Octocode's versioned JSONL RPC still
owns stdin/stdout framing, request IDs, cancellation, ordered events, and child
responses. The Rust layer stages and leases each AI message before stdin is
written, acknowledges it after the matching response, and releases it when the
write or child process fails. An expired lease is reclaimable after restart.
Parent restart atomically abandons stranded session-scoped worker messages before
new work starts. Octocode doesn't replay a message when its prior delivery outcome
is unknown.

Canonical worker progress covers queued, running, and terminal state. It includes
active, queued, and maximum capacity plus optional explicit plan-step and task
labels. It excludes prompts, thinking, results, reasons, process details, and
terminal handback. Visual and alternate terminal output use the same safe contract.

The Rust database contains the full worker input text because replay requires
the original message. Protect the database as sensitive local agent state.
`--no-session` keeps the runtime and worker messages in memory instead.

## Verify a checkout

After changing core scheduling, MCP, help, or workers, rebuild and run the real
package gate:

```bash
yarn workspace @octocodeai/agent-core verify
yarn workspace @octocodeai/agent-core build
yarn workspace octocode-agent verify
node packages/octocode-agent/out/octocode-agent.mjs run --help
node packages/octocode-agent/out/octocode-agent.mjs serve --allow-workers --help
```

The native verification suite includes a real built root-to-child leaf flow,
process cleanup, child-tool exclusion, depth-bypass rejection, redaction checks,
MCP overlap sensors, and command-scoped help tests.
