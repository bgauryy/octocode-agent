# Architecture and protocol reuse receipt

Date: 2026-08-28  
Scope: orchestrated prompt audits, upstream research, and dirty-tree implementation  
Release effect: none; the migration remains **HOLD**

## Verdict

The native runtime keeps its host-neutral kernel, policy chain, effect
ownership, sessions, Zustand presentation store, OpenTUI adapter, and official MCP
client. Replacing that system with XState, Effect, RxJS, Vercel AI SDK, or OpenAI
Agents creates overlapping owners without closing the proven parity gaps.

The project reuses established protocol implementations at adapter
boundaries:

- The native OpenAI path uses `openai@7.8.0` and a dedicated Responses
  `ModelPort`. SDK retries remain zero until the runtime owns attempt IDs, reset
  semantics, and partial-stream safety.
- The editor adapter uses `@agentclientprotocol/sdk@1.4.0`. ACP maps native
  sessions, updates, permissions, cancellation, terminal operations, and MCP
  bridging; it does not replace native RPC or internal Awareness coordination.
- The native MCP path uses `@modelcontextprotocol/client@2.0.0`, a session-owned
  connection manager, negotiated list-change invalidation, and ordered progress
  projection. Elicitation still needs the native interaction broker. The SDK's
  negotiated 2026 era excludes the deprecated `tasks/*` methods, so the runtime
  doesn't add a private Tasks envelope.
- Use OpenTelemetry GenAI semantic conventions through an optional redacted
  projection. Core lifecycle events remain the source of truth.
- Use `p-retry` only as abortable delay mechanics after the runtime defines the
  retry envelope. It must not decide whether an effect is safe to repeat.
- Keep A2A outside the local worker bus. Use it only for a future approved remote
  agent boundary; Awareness remains the durable local coordination store.

## Implemented architecture cleanup

- Split OpenTUI presentation ownership from terminal construction and removed the
  `index.ts` and `terminal-controller.ts` source cycle.
- Replaced the internal 16-module widget barrel with direct owner imports and
  deleted it.
- Added a native architecture test that rejects wildcard barrels, internal index
  imports, and OpenTUI cycles.
- Routed native Octocode-home resolution through the shared path owner, including
  MCP discovery, and removed the duplicate native resolver.
- Replaced the Awareness SQL aggregate import with `sql/signals.ts` and deleted the
  unused SQL barrel.
- Removed the Pi discovery-file proxy export; its tests now import the MCP
  discovery owner directly.
- Removed declaration-only native picker and helper exports after scoped search
  and package-export inspection showed no consumers.
- Added an independent runtime turn deadline. A provider promise that ignores its
  abort signal no longer leaves the turn open forever; the runtime reports a
  distinct `timeout` terminal outcome.
- Added a session-owned MCP manager that reuses one connection per server,
  invalidates tool catalogs from negotiated list-change notifications, evicts
  failed connections, and gives concurrent shutdown callers one close barrier.
- Made `tool.requested` lifecycle rewrite, deny, stop, and context decisions
  authoritative before validation, policy, approval, and execution. Durable
  history stores the effective rewritten call, preserves the original call ID,
  and replays lifecycle context exactly once after correlated tool results.
- Wired runtime shutdown to close the MCP manager owned by the default tool
  registry exactly once.
- Added the official-SDK Responses adapter with typed streaming fixtures,
  `maxRetries: 0`, stable prompt-cache routing, and provider-reported cache-read
  and cache-write usage.
- Made Responses the default for `api.openai.com`; custom OpenAI-compatible
  endpoints remain on Chat Completions unless explicitly configured.
- Added ordered MCP request-progress projection through canonical tool updates.
- Extended lifecycle authority to input and `context.preparing`. Rewrite,
  context, deny, and stop decisions now happen before model invocation, and
  denied or stopped input doesn't enter durable resume history.
- Added an ACP v1 adapter, canonical runtime bridge, and stdio server entry. The
  bridge owns one runtime per ACP session and maps cancellation, text, progress,
  tools, and plans without handwritten JSON-RPC envelopes.

Public package entrypoints and documented compatibility shims remain. Deleting
those exports is a versioned public-API migration, not an internal cleanup.

## Verification receipt

- Root `yarn lint`, `yarn typecheck`, `yarn test`, and `yarn build` pass.
- Core: 65 tests pass. Native agent: 371 tests pass and 16 remain intentionally
  skipped. Awareness: 986 tests pass with 89.08% statement and 92.94% line
  coverage. Pi extension: 1,760 tests pass.
- The handoff brief test passes in three consecutive isolated runs after stable
  file ordering replaced insertion-order output.
- The built native launcher returns its command surface from `--help`; the live
  Octocode CLI returns 15 tools, compact context, and the local-search/LSP schemas.
- Architecture searches find no native wildcard exports, widget-barrel imports,
  OpenTUI index imports, or internal `./index.js` imports.
- LSP resolves 14 references across five files for the new OpenTUI composition
  root and both runtime references for the turn-deadline option.
- Style lint reports no errors or warnings in the two new architecture documents.

## Current ratings

| Area | Implementation | Target | Evidence-limited reason |
|---|---:|---:|---|
| Event-loop correctness | 9.0/10 | 8.5/10 | Iteration, tool-call, result-size, queue, backpressure, wall-time, input, context, and pre-effect lifecycle bounds execute |
| Prompt/cache stability | 8.3/10 | 8/10 | Frozen prefixes, stable cache routing, and provider-reported read/write usage execute; retry/reset envelopes and live cache measurements remain open |
| Skill/MCP discovery | 8.3/10 | 8/10 | Session ownership, list-change invalidation, and progress work; elicitation and one provenance-rich inventory remain open |
| Communication/protocol plane | 6.9/10 | 6.5/10 | Input/context/tool authority and ACP v1 stdio are composed; native worker supervision and Awareness-backed durable mailboxes remain open |

The communication score measures production composition. ACP and lifecycle
authority close the target, but worker supervision, durable mailboxes, and
real-editor conformance remain release blockers. Scores don't change release
readiness.

## Upstream evidence

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

## Complete the remaining implementation gates

1. Define provider attempt, reset, idempotency, and partial-output envelopes before
   adding retry mechanics.
2. Connect MCP elicitation to the native interaction broker and add a
   provenance-rich discovery inventory. Revisit Tasks only through a negotiated
   current extension or protocol era.
3. Compose native worker supervision and Awareness-backed durable mailboxes.
4. Run real-host Pi/native, editor, and live-provider cache conformance.
