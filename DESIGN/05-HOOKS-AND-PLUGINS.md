# Hooks and Plugins

## Goal

Provide one production extension pipeline in which trusted hooks and permissioned plugins can observe or influence canonical lifecycle events without bypassing policy, leaking secrets, escaping their roots, duplicating effects, or preventing safe unload.

## Current gaps

### Hooks

- Codex hook schemas and catalog eligibility exist, but there is no production command-hook executor, MCP-hook executor, matcher dispatcher, decision parser, timeout/process cleanup, bounded async queue, output spill, or redaction pipeline.
- The native kernel executes effects directly and does not dispatch pre-effect lifecycle decisions.
- Discovery covers only a subset of user/workspace files. Managed layers, enabled plugin bundles, and all supported inline forms are incomplete.
- Discovered descriptors can be projected as trusted before their exact current hash has been reviewed.
- Schema validation accepts invalid combinations such as asynchronous MCP hooks and invalid context limits.

### Plugins

- `PluginActivator` is exercised only in tests and is not composed into the production launcher.
- Grants are not sufficiently bound to plugin identity, manifest hash, revision, and expiry.
- Activation callbacks can register contribution kinds or owners not authorized by the manifest/grant.
- Plugin path checks are lexical rather than normalized realpath containment checks.
- Lease tracking is disconnected from deactivation, so unload does not prove that no work remains.
- Most Pi contribution kinds cannot be unloaded dynamically.
- Lifecycle diagnostics can expose raw plugin error messages.

## Target hook pipeline

For every canonical hook event:

1. Build a versioned, redacted event envelope with session, turn, request, tool, and effect correlation.
2. Resolve active sources in deterministic precedence order: managed, user, trusted workspace, session, and enabled plugins.
3. Parse and validate every source. Invalid entries are diagnosed and skipped without making the whole catalog unsafe.
4. Require exact-hash review for every non-managed definition. Changed definitions return to review-required.
5. Apply event-specific matcher semantics.
6. Execute synchronous handlers concurrently where allowed, using bounded concurrency and deadlines.
7. Execute asynchronous command handlers through a bounded queue with explicit ownership and shutdown behavior.
8. Normalize outputs into canonical decisions: continue, block, rewrite input, add context, warn, or fail according to event policy.
9. Redact secrets and spill oversized payloads to a protected file reference.
10. Record timing, result class, source identity, and correlation IDs without storing secrets.

MCP hooks are synchronous, do not trigger recursive hooks, use an existing MCP connection, and fail according to the event's documented blocking policy. Session-end hooks must complete synchronously within their deadline.

## Target plugin lifecycle

### Installation and enablement

- Parse a versioned manifest and canonicalize its content.
- Compute and persist the manifest hash.
- Resolve all declared paths by normalized realpath and prove containment within the plugin root.
- Show requested permissions and contributions before granting them.
- Bind each grant to plugin ID, manifest hash, grant revision, scope, expiry, and explicit denied permissions.

### Transactional activation

- Open a contribution transaction owned by the plugin.
- Permit only contribution kinds declared by the manifest and authorized by the active grant.
- Reject owner spoofing and undeclared activation events.
- Commit all contributions atomically or roll them all back.
- Register leases for running handlers, tool calls, UI surfaces, background tasks, and resources.

### Disable, update, and unload

- Stop accepting new plugin work.
- Cancel or drain owned work within a bounded deadline.
- Require the lease registry to report zero live leases before unload.
- Remove every contribution transactionally.
- Preserve diagnostics and rollback state without preserving secrets.
- Treat an update as install-new, validate/grant, activate-new, then retire-old; failure keeps the old version active.

## Settings surface

The Hooks panel must show source, scope, hash, review state, enabled state, event/matcher/handler summaries, permissions, last timing, recent failures, and a synthetic dry-run action.

The Plugins panel must show identity, version, provenance, manifest hash, requested/granted/denied permissions, contributions, leases, health, update state, and enable/disable/unload controls with revision-safe mutations.

## Acceptance criteria

- No tool/model/session effect occurs before all applicable blocking hook decisions finish.
- Unreviewed or changed non-managed hooks never execute.
- Managed-only mode excludes every non-managed source.
- No plugin contribution exists without both manifest declaration and a current grant.
- No plugin path can escape through `..`, absolute paths, or symlinks.
- Disable/update/unload leaves zero contributions and zero leases.
- Handler timeouts, crashes, malformed output, cancellation, and shutdown have deterministic outcomes.
- Secrets do not appear in settings projections, lifecycle events, diagnostics, or spill metadata.

## Mandatory tests

- Source precedence, merge, trust hash change, managed-only mode, and untrusted-workspace cases.
- Matcher behavior for every event and ignored-matcher cases.
- Command/MCP success, block, rewrite, context, malformed output, timeout, cancellation, and unavailable server.
- Concurrent synchronous hooks and bounded asynchronous queues.
- Plugin grant expiry/hash/revision/identity mismatch.
- Undeclared contribution and owner-spoof rejection.
- Symlink and traversal containment tests.
- Activation rollback, update rollback, lease-blocked unload, and clean unload.
- Redaction and large-output spill tests.
- Production composition test proving a pre-tool hook blocks a real native tool call.
