# Traceability Checklist

Nothing in this file is complete merely because a type, class, test fixture, or settings panel exists. Close an item only after production composition and required verification.

## Runtime and policy

- [ ] One runtime-owned scope joins all turn/request/tool/hook/plugin work before shutdown.
- [ ] Every turn and runtime emits exactly one valid terminal sequence.
- [ ] Input normalization and schema validation precede policy and execution.
- [ ] Trust, managed policy, plan, peer locks, hooks, and approval gate every effect.
- [ ] No internal, RPC, plugin, hook, retry, or resume path bypasses the effect boundary.
- [ ] Steering and follow-up work during streaming.
- [ ] Active cancellation propagates; idle cancellation cannot poison the next turn.
- [ ] Prompt assembly includes canonical system/context fragments and model-visible history.
- [ ] Model and thinking changes are catalog/capability validated.
- [ ] Provider streams, tool calls, terminal reasons, errors, usage, and retries are canonical and correlated.

## Tools and transports

- [ ] Tool effect classifications match actual filesystem/network/process behavior.
- [ ] Tool progress/result/error events are complete and redacted.
- [ ] Print and JSON subscribe before start and remain through stop.
- [ ] RPC uses command-specific schemas, correlated failures, and concurrent dispatch.
- [ ] Mode-specific stdout/stderr isolation and exit codes are verified.

## Sessions and compaction

- [ ] Resume and continue restore the exact model-visible context.
- [ ] Create, switch, name, fork-at-entry, tree, rewind, navigate, export, compact, and cancel are production commands.
- [ ] `--no-session` performs no durable session write.
- [ ] Concurrent writers cannot lose committed events.
- [ ] Missing/corrupt primary recovery uses a valid backup safely.
- [ ] Session envelopes and event graphs receive full semantic validation.
- [ ] Forks repair every event/branch/compaction reference.
- [ ] Migration is source-stable, transactional, retryable, and byte-preserving.
- [ ] Partial assistant streams survive defined crash boundaries.
- [ ] Compaction is durable, cancellable, bounded, retry-limited, and repeatable.

## TUI

- [ ] One OpenTUI-owned editor handles input, focus, keymaps, mouse, resize, and clipboard.
- [ ] Selection, confirmation, approval, steer, follow-up, and cancel interactions work.
- [ ] Thinking, tools, progress, results, errors, widgets, header, and footer render correctly.
- [ ] Streaming updates are queued and coalesced without semantic loss.
- [ ] Initialization, shutdown, signals, and failures always restore the terminal.
- [ ] Headless modes do not load native OpenTUI/FFI code.
- [ ] PTY, narrow terminal, Unicode, accessibility, capability, and platform suites pass.

## Settings

- [ ] Native `/settings` and deep links are production-reachable.
- [ ] Native and Pi use one typed canonical settings registry/service.
- [ ] Every projection and diagnostic redacts secret-shaped values.
- [ ] Mutations require expected revisions and return typed conflicts.
- [ ] Scope, precedence, provenance, diff, impact, rollback, and recovery are visible.
- [ ] Model selection resolves against the effective catalog.
- [ ] Models, Hooks, Plugins, MCP, and Skills panels implement their required controls.
- [ ] Workspace actions fail closed when trust cannot be established.
- [ ] CSP, origin, host, token, body-size, containment, and no-store controls pass.

## Hooks

- [ ] Managed, user, trusted-workspace, session, inline, and plugin sources are discovered correctly.
- [ ] Exact-hash review governs every non-managed hook.
- [ ] Command and synchronous MCP handlers execute with correct matcher/event semantics.
- [ ] Block, rewrite, context, warning, timeout, failure, and cancellation decisions are deterministic.
- [ ] Async command work is bounded and owned through shutdown.
- [ ] Hook output is redacted and oversized output spills safely.
- [ ] Blocking hooks run before the effect they govern.

## Plugins

- [ ] Production plugin discovery and activation are composed.
- [ ] Grants bind plugin ID, manifest hash, revision, scope, permissions, and expiry.
- [ ] Contributions are manifest-declared, grant-authorized, owner-correct, and transactional.
- [ ] Every plugin path passes normalized realpath containment.
- [ ] Activation/update failures roll back without disturbing the previous active version.
- [ ] Disable/unload drains work, checks leases, and removes every contribution.
- [ ] Plugin diagnostics and settings projections are redacted.

## Conformance and release

- [ ] Scenarios invoke real Pi and native hosts.
- [ ] Normalization preserves identity relationships, ancestry, order, and meaningful paths.
- [ ] One cross-host ledger prevents duplicate and unregistered external effects.
- [ ] All mandatory scenarios pass in pure and shadow modes.
- [ ] Security bypass tests cover CLI, RPC, hooks, plugins, retries, migrations, and resume.
- [ ] Shadow thresholds pass.
- [ ] Canary thresholds and observation window pass.
- [ ] Rollback succeeds using the release artifact and durable sessions.
- [ ] Native default gates pass on every supported platform.
- [ ] Pi code/dependencies/configuration/tests/docs are removed only after all prior checks.
- [ ] Clean install and supported upgrade pass after removal.
