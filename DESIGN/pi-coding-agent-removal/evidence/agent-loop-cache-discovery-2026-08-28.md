# Agent loop, cache, and discovery hardening receipt

Date: 2026-08-28  
Scope: dirty-tree native runtime increment  
Release effect: none; the migration remains **HOLD**

## Result

The native agent loop now has a cache-stable model prefix for one durable session
generation. The runtime snapshots the system prompt and model-facing tool schemas,
clones every provider request, and persists the prompt receipt with the session.
Changing `AGENTS.md`, Skill roots, MCP configuration, or the mutable tool registry
does not silently rewrite an active session's leading prompt/tool bytes.

The event loop and transport boundary also close four correctness bugs found by
independent audits:

- Each provider iteration emits one `message.started`, correlated deltas, and one
  `message.ended` with a distinct message ID.
- Assistant output reaches durable model history only after the provider envelope,
  stop reason, tool-call parity, and tool-call budget pass validation.
- A valid `{ ok: false }` tool result emits a canonical error outcome while its
  bounded JSON envelope remains available to the next model iteration.
- RPC JSONL writes are serialized, bounded, and drain-aware. Slow consumers no
  longer cause ignored stream backpressure or interleaved frames.

## Cache contract

The stable prefix is ordered as system prompt, prior model-visible session history,
current user input, then dynamic tool results. Repository instructions are loaded
only for an explicitly trusted workspace. A SHA-256 receipt and semantic digest are
stored as `native.prompt.snapshot`; resume reuses the validated stored content.
Starting a new session is the refresh boundary.

The OpenAI-compatible adapter sends `prompt_cache_key` only for the official
`api.openai.com` endpoint. Provider usage continues to project cached input tokens.
This matches OpenAI's requirement that cache hits depend on exact leading-prefix
matches and that stable content and tool definitions precede changing content:
[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

MCP tool catalogs no longer assume a fixed 30-second lifetime. The client honors
`ttlMs`, treats a missing or zero value as immediately stale, and rejects inconsistent
`cacheScope` values across pages. The implementation conservatively expires the
aggregated catalog at the shortest page TTL. This follows the MCP cache model while
avoiding stale cross-page aggregation:
[MCP caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching).

## Discovery and trust

One shared `repositoryDirectories()` helper now owns root-to-working-directory
discovery. Agent Skills and MCP configuration use the same least-specific to
most-specific precedence:

1. user and Octocode-global roots;
2. repository root;
3. each ancestor directory;
4. working directory.

More-specific MCP server definitions replace earlier definitions. The agent can list
Skill metadata in an untrusted workspace, but it cannot load workspace Skill
instructions or support files until that exact workspace is trusted. The MCP surface sorts server names and
status rows are sorted so semantically equivalent configuration ordering does not
change model-facing bytes.

## Verification

- Root tests: 3,233 passed; 15 intentional native non-FFI cases skipped.
- Root lint: passed.
- Root typecheck: passed.
- Changed-package builds: `@octocodeai/agent-core`,
  `@octocodeai/octocode-shared`, and `octocode-agent` passed.
- Built launcher smoke: `node packages/octocode-agent/out/octocode-agent.mjs --help`
  passed.
- Live Octocode catalog: `npx octocode context --compact` and
  `npx octocode tools --json` passed.
- AST search confirmed the native exported surface; LSP confirmed production and
  test references for `createDefaultNativeRuntime` and `loadNativeMcpServers`.

Focused regression coverage includes adapter mutation, per-iteration message
identity, tool error envelopes, invalid-provider persistence ordering, durable prompt
resume, hierarchical Skill/MCP discovery, untrusted Skill loading, deterministic MCP
metadata, zero-TTL refetch, prompt-cache keys, hidden thinking in print mode, and RPC
backpressure.

## Rating

| Area | Before | After | Reason |
|---|---:|---:|---|
| Event-loop correctness | 6.5/10 | 8.5/10 | Canonical message boundaries, validation-before-persistence, error envelopes, and bounded backpressure are executable |
| Prompt/cache stability | 5.5/10 | 8/10 | Durable prompt receipt, cloned requests, frozen tool schemas, cache routing key, and cached-token telemetry are present |
| Skill/MCP discovery | 6/10 | 8/10 | Shared hierarchy, deterministic precedence, and workspace trust gates are present |
| Communication/protocol plane | 5.5/10 | 6.5/10 | Event causality improved; native mailbox/worker composition and full MCP lifecycle remain absent |

These are implementation-quality ratings, not release readiness scores.

## Deliberate leftovers

- Add parent event/request IDs and one execution owner for retry and idempotency.
- Replace the Chat Completions adapter with a dedicated Responses adapter before
  claiming reasoning, cache-write telemetry, or full OpenAI protocol coverage.
- Add MCP list-change subscriptions, independently reusable per-page cache entries,
  authorization-context cache identities, multi-round-trip `input_required`, progress,
  resource templates, and durable tasks.
- Compose Awareness worker registry, mailbox, leases, handoff, and peer-lock state as
  the native communication bus. Do not invent a second agent-to-agent store.
- Add a provenance-rich discovery inventory for valid, shadowed, malformed, disabled,
  and trust-blocked MCP, Skill, prompt, and settings inputs.
- Define an explicit prompt refresh/migration command. Resume intentionally remains
  frozen until that policy exists.
