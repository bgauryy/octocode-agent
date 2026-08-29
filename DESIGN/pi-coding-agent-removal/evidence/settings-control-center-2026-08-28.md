# Native settings control-center receipt — 2026-08-28

Status: Accepted bounded dirty-tree increment; release remains **HOLD**.

## Scope

This receipt covers the native `/settings [section]` slice only. It does not close
Stage 5, Step 8, any `U-*` feature, native-default readiness, or Pi retirement.

## Implemented evidence

- `native-command-catalog.ts` provides one authority for slash routing, help, and
  composer completion.
- `native-settings-page.ts` owns a process-scoped loopback server, section anchors,
  allowlisted projection, and typed revision-checked theme/default-model mutations.
- The server checks Host, Origin, token, method, content type, body size, schema,
  action count, key allowlist, and value constraints. Responses include restrictive
  CSP, no-store, nosniff, referrer, and frame protections.
- The launcher and slash router compose the page without importing browser or HTML
  behavior into agent core.
- The JSON and RPC transports project internal lifecycle events before serialization;
  private context messages become a public message count.

## Verification receipt

- Native package tests: 397 passed, 16 skipped after the public-event regression fix.
- Native package build, lint, and typecheck passed.
- Built text and JSON headless flows completed against a deterministic loopback SSE
  model, including usage telemetry.
- The OpenTUI path launched on Node 26.4.0 with the documented experimental FFI flag.
- Desktop and mobile browser checks verified rendering, section navigation, mutation,
  persisted next-session values, and security/error behavior.
- A live Pi 0.84.3 RPC smoke restored a session and reported 1 MCP server, 15 tools,
  automatic compaction, and the Pi extension command inventory. Because the supported
  oracle pin is 0.84.2, this smoke is not version-conformance evidence.

## Post-receipt status and remaining acceptance work

Post-receipt update: later work in the same dirty tree composed a core
`SettingsRegistry`/`SettingsService` persistence bridge across native runtime model
selection and the page. It also added the trust-gated native extension controller.
The original receipt and test counts above remain unchanged as historical evidence.

- Move launcher config commands, automation, model-source transactions, and the
  temporary Pi adapter onto the canonical service already used by runtime model
  selection and the native page.
- Implement complete Models, Hooks, Plugins, MCP, Skills, trust, provenance, diff,
  conflict, backup, import, rollback, and recovery workflows.
- Validate default model changes against the effective catalog.
- Run the complete native/Pi conformance, browser security/accessibility, real PTY,
  supported-platform, packaged-artifact, and rollback matrices.
