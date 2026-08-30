# Resources: Remove `pi-coding-agent`

## Primary sources

| Resource | Link or path | Why it matters |
|---|---|---|
| Repository agent guide | `AGENTS.md` | Defines package ownership, external dependencies, build order, dogfood tools, and verification requirements. |
| Agent core package | `packages/octocode-agent-core/` | Current host-neutral owner for runtime contracts and implementations. |
| Agent/Pi integration guide | `packages/octocode-agent/docs/PI_INTEGRATION.md` | Documents launcher modes and current integration expectations. |
| Native launcher | `packages/octocode-agent/src/native-launcher.ts` | Current native runtime composition, session hydration, policy, tools, and transports. |
| Extension host contracts | `packages/octocode-pi-extension/src/types.ts:235-390,517-595` | Defines UI, context, tool, command, event, and host compatibility surfaces. |
| Extension composition | `packages/octocode-pi-extension/src/index.ts:1175-1896,2595-2601` | Defines tool phases, lifecycle middleware, prompt hooks, and extension entrypoint. |
| Existing hook composer | `packages/octocode-pi-extension/src/hook-composer.ts` | Defines current ordered middleware merge/block/error behavior and the concentrated Pi adapter seam. |
| Tool registration funnel | `packages/octocode-pi-extension/src/tools/octocode-tools.ts:98-125` | Proves all Octocode tools cross one registration boundary. |
| Shell structural runtime | `packages/octocode-pi-extension/src/shell/shell.ts:29-90,180,252,262` | Defines the small runtime/session surface needed by the custom shell. |
| Session listing | `packages/octocode-agent/src/sessions.ts` | Establishes Pi session buckets as a compatibility input. |
| Native transports | `packages/octocode-agent/src/native-transports.ts` | Current print, JSON, and RPC composition and protocol behavior. |

## Historical baseline code references

The removed `sdk-launcher.ts`, legacy launcher line anchors, and `serve.ts` entries below describe the accepted 2026-08-26 extraction baseline. They are not current paths and must not be used as implementation instructions.

| Area | File and lines | Decision relevance |
|---|---|---|
| Pi SDK import | `packages/octocode-agent/src/sdk-launcher.ts:168` | Runtime package load to remove. |
| Pi SDK destructuring | `packages/octocode-agent/src/sdk-launcher.ts:241-251` | Exact SDK API inventory. |
| Pi package resolution | `packages/octocode-agent/src/launcher.ts:100` | Package constant and executable resolution input. |
| Official Pi types | `packages/octocode-pi-extension/src/types.ts:9-21` | Type-only coupling that still shapes production contracts. |
| Shell helper | `packages/octocode-pi-extension/src/tools/bash-tool.ts:14` | Standalone helper extraction. |
| Frontmatter helpers | `packages/octocode-pi-extension/src/tools/dynamic-skills.ts:23` | Standalone parser extraction. |
| Settings manager | `packages/octocode-pi-extension/src/tools/image-render.ts:25` | Settings extraction. |
| Deep HTML exporter | `packages/octocode-pi-extension/src/tools/export-command.ts:109-129` | Unsupported/deep runtime coupling to replace. |
| Session identity | `packages/octocode-pi-extension/src/tools/session-artifacts.ts:20-110` | Proven session ID/file consumers. |
| Branch/leaf behavior | `packages/octocode-pi-extension/src/tools/rewind-command.ts:104-108`; `src/tools/compaction-state.ts:113-125` | Shows requirements beyond the broad session facade. |
| Direct tool palette | `packages/octocode-pi-extension/src/constants.ts:19-49` | Defines disabled/overridden built-ins and the 17-tool palette. |
| Deterministic host harness | `packages/octocode-agent-testing/src/index.ts` | Candidate shared Pi/native contract oracle. |
| Harness tests | `packages/octocode-agent-testing/tests/pi-flow-harness.test.ts` | Covers ordered tool, UI, session, abort, and fail-closed behavior. |
| Full extension mock flow | `packages/octocode-pi-extension/tests/mock-pi-host-flow.test.ts` | Proves the extension can boot and run against the structural harness. |
| Native terminal boundary | `packages/octocode-agent/src/terminal/opentui/` | Keeps `@opentui/core` imports outside agent core and noninteractive transports; the 2026-08-28 candidate production-composes it. |
| Existing settings control center | `packages/octocode-pi-extension/src/tools/mcp-html.ts` | Eight-section `settings.html`, 11 validated actions, protected loopback server integration, and the implementation to generalize. |
| Settings behavior guide | `packages/octocode-pi-extension/docs/SETTINGS.md` | Documents current commands, sections, persistence, precedence, security, refresh, and lifecycle behavior. |
| Native settings | `packages/octocode-agent/src/native-settings.ts` and agent-core settings contracts | Current native persistence and the canonical service boundary still to compose fully. |
| Existing OpenTUI proof adapter | `packages/octocode-pi-extension/src/shell/opentui-adapter.ts` | Injects a four-method native surface and maps submit/abort plus output without exposing renderer handles; the inspected snapshot has no production caller. |
| Existing OpenTUI view model | `packages/octocode-pi-extension/src/shell/opentui-view-model.ts` | Provides a versioned immutable running/transcript snapshot and streaming-delta coalescing behavior to preserve. |
| Existing OpenTUI proof tests | `packages/octocode-pi-extension/tests/opentui-shell.test.ts` | Four tests cover immutable streaming rows, mapping, idempotent teardown order, and pre-mount output. |

## External prior art and related systems

| Resource | Link | Lesson for this RFC |
|---|---|---|
| Accepted custom TUI protocol RFC | Historical decision referenced by the 2026-08-26 baseline; original `.octocode/rfc/...` path is no longer present | A subprocess/RPC client was a migration boundary, not the desired runtime owner. |
| Custom TUI resolution and fixtures | Historical decision referenced by immutable receipts; original `.octocode/rfc/...` paths are no longer present | Preserve discriminated wire semantics and normalized fixtures without importing Pi protocol types. |
| Awareness Pi-surface consolidation RFC | Historical decision referenced by immutable receipts; original `.octocode/rfc/...` path is no longer present | Preserve one model-facing plan/coordination contract while changing its host adapter. |
| Pi agent session source | <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts> | Shows why copying the large coupled session implementation is not the target design. |
| Pi session manager source | <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts> | Use observed capabilities and migration fixtures instead of cloning the full manager API. |
| Pi extension runner source | <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/runner.ts> | Provides ordering and middleware behavior to capture before replacement. |
| Pi agent loop source | <https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts> | Supports separating model/tool loop replacement from coding-agent host removal. |
| OpenTUI official repository | <https://github.com/anomalyco/opentui> | Establishes the Zig-backed TypeScript Core package and optional React/Solid separation. |
| OpenTUI runtime support | <https://opentui.com/docs/getting-started/runtime-support> | Defines the current Bun and Node.js/FFI requirements and native-asset constraints that the packaging spike must prove. |
| OpenTUI package entry points | <https://opentui.com/docs/reference/package-entrypoints> | Establishes supported `@opentui/core` and `@opentui/core/testing` imports. |
| OpenTUI testing | <https://opentui.com/docs/core-concepts/testing> | Provides deterministic in-memory renderer, input, mouse, clock, capability, spy, and frame facilities. |
| Official Codex hooks documentation | <https://learn.chatgpt.com/docs/hooks> | Defines supported lifecycle events, JSON/TOML discovery and merge, matchers, command/MCP handlers, input/output, async constraints, plugin hook packaging, exact-definition trust, managed policy, timeouts, and output handling. |
| Codex app-server and multi-agent source | <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>; <https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents.rs> | Establishes bounded/generated machine protocols, session lifecycle, streaming progress, tool search, and subagent control prior art. |
| Gemini CLI ACP/checkpoint/routing/worktree/subagent docs | <https://github.com/google-gemini/gemini-cli/tree/main/docs> | Establishes current ACP, selective recovery, model routing, worktree isolation, and specialist-agent product flows. |
| OpenCode ACP and permissions | <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/agent.ts>; <https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx> | Establishes stabilized ACP session methods and granular action/path/agent permission rules. |
| Aider repository map | <https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md> | Establishes dependency-ranked, token-budgeted semantic repository context. |
| Cline checkpoints | <https://github.com/cline/cline/blob/main/docs/core-workflows/checkpoints.mdx> | Establishes diff review and independent file/task/combined restore UX. |
| Agent Client Protocol | <https://agentclientprotocol.com/get-started/introduction>; <https://agentclientprotocol.com/updates> | Establishes the cross-editor agent protocol and stabilized session list/resume/close/config capabilities. |
| MCP specifications | <https://modelcontextprotocol.io/specification/2025-06-18/index>; <https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks> | Establishes stable MCP capabilities and the separately evolving durable-tasks extension boundary. |
| A2A specification | <https://a2a-protocol.org/dev/specification/> | Establishes remote agent cards/tasks/streaming/push prior art and why it is deferred from local cutover. |
| AGENTS.md open format | <https://agents.md/> | Establishes hierarchical repository instruction discovery and nearest-file precedence. |

## Internal research artifacts

| Artifact | Path | What it supports |
|---|---|---|
| RFC entry point and agent guide | `README.md` | High-level target, document ownership, reading paths, work/update protocol, evidence rules, validation, and stop conditions. |
| Current-state inventory | `RFC.md` §Motivation and current state | Quantitative AST/LSP coupling baseline. |
| Readiness ledger | `PREREQUISITES.md` | Evidence confidence, blockers, and canonical baseline protocol. |
| Readiness and feature matrix | `READINESS_AND_FEATURE_MATRIX.md` | Rated implementation maturity, complete feature IDs, current/target comparison, and sourced external extensibility comparison. |
| Build and rollback plan | `IMPLEMENTATION.md` | Dependency-ordered phases and deletion gates. |
| Operational steps | `STEPS.md` | Document-linked execution checklist, outputs, and stop conditions. |
| Progress status | `STATUS.md` | Current stage, step, feature-group, blocker, owner, evidence, and change-log state. |
| Measurement contract | `KPI.md` | Before/after metrics, behavioral matrix, and decision rules. |
| Detailed comparison | `BEFORE_AFTER.md` | Layer-by-layer before/after state and evidence receipt schema. |
| Impact assessment | `IMPACT.md` | User, package, API, data, security, reliability, operational, and maintenance impact. |
| Stage roadmap | `MIGRATION_STAGES.md` | Entry, exit, evidence, hold, and rollback gates for each migration stage. |
| Mandatory test plan | `TEST_PLAN.md` | Required environments, suites, fixtures, faults, security checks, performance checks, and release sign-off. |
| Schemas and types | `SCHEMAS_AND_TYPES.md` | Canonical contract ownership, module layout, runtime/schema rules, versioning, and Pi-extension mapping. |
| Hooks and plugins | `HOOKS_AND_PLUGINS.md` | Canonical event bus, Codex compatibility, trust, handlers, manifests, contributions, settings integration, tests, migration, and rollback. |
| OpenTUI terminal core | `OPENTUI_TERMINAL_CORE.md` | Native terminal decision, boundary, runtime/package gate, lifecycle, mappings, tests, performance, accessibility, and rollback. |
| Unified settings HTML | `SETTINGS_WEB_UI.md` | Registry/page ownership, all settings, Models/`models.json`, source precedence, mutation protocol, security, tests, and rollback. |
| Future before receipt | `evidence/before-<commit>.md` | Canonical pre-migration environment and results. |
| Future after receipt | `evidence/after-<commit>.md` | Candidate post-migration environment and results. |
| Future comparison | `evidence/comparison-<before>-<after>.md` | Signed difference and rollout decision. |
| Coding-agent landscape | `evidence/coding-agent-landscape-2026-08-28.md` | Current competitors, Octocode adoption, ACP/MCP/A2A/AGENTS decisions, AST/LSP receipts, and the eight-feature delta. |

## Reproducible research queries

The 2026-08-26 inventory used Octocode local structural search and LSP, not raw text search as semantic proof:

- Search production `src/**/*.ts` for `@earendil-works/pi-(coding-agent|tui|agent-core|ai)` to locate the package-coupling surface.
- Structurally search `packages/octocode-pi-extension/src` for `pi.$METHOD($$$ARGS)` to inventory direct host calls.
- Structurally search for `hooks.on($EVENT, $$$ARGS)` to inventory composed middleware.
- Structurally search both `pi.registerCommand($NAME, $$$ARGS)` and `pi.registerCommand?.($NAME, $$$ARGS)` to distinguish 18 central and 8 optional module registrations.
- Structurally search for `pi.registerTool?.($DEF)` to prove the single registration funnel.
- Run LSP references from `PiInstance`, `PiContext`, and `ToolDefinition` declarations in `packages/octocode-pi-extension/src/types.ts`.
- Search composed `hooks.on(...)` and direct `pi.on(...)` candidates, then use LSP and ordered runtime traces to prove production listeners and mappings.
- Follow text/AST anchors with exact file reads; treat comments and strings separately from imports and calls.

Store exact JSON queries and tool versions in each evidence receipt because schemas and source line numbers can change.

## Open research leads

- Native session encoding benchmarks and corruption behavior — decision-grade when all candidates run the same fixture corpus.
- Supported-platform terminal restoration and signal behavior — decision-grade when CI or recorded manual runs cover each supported environment.
- Real-world redacted latency, memory, abort, and compaction baselines — decision-grade after telemetry fields and privacy review are approved.
- Long-term removal of `pi-agent-core` or `pi-ai` from the independent Pi stack is outside this RFC. Native `pi-tui` removal is part of the OpenTUI stage; Pi-host UI remains adapter-local to the Pi extension.
