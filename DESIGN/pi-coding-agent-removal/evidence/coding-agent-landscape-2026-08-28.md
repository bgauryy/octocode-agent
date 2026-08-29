# Coding-agent landscape and protocol audit — 2026-08-28

Status: decision-grade research input; implementation claims remain subject to local receipts.

## Question and method

This audit asks which current coding-agent capabilities materially change the native Octocode target. It compares primary repository sources and protocol specifications, then checks the local candidate with Octocode structural AST search and LSP references. Search hits are discovery evidence; only exact source reads and semantic reachability support conclusions.

The comparison is feature-oriented, not a popularity ranking. Repositories were selected because they are prominent open-source coding agents or contain a differentiated implementation relevant to this RFC: OpenAI Codex, Gemini CLI, Qwen Code, OpenCode, goose, Aider, and Cline.

## Octocode adoption check

GitHub code search for `@octocodeai/pi-extension`, `npx octocode`, `octocode-awareness`, `octocode-research`, and `.octocode` found confirmed use primarily in Octocode-owned repositories (`bgauryy/octocode-agent`, `bgauryy/octocode`, `bgauryy/octomentis`, `bgauryy/octocode-mcp-host`, and related packages), plus skill mirrors such as `gabrielmoreira/agent-skills-mirror`. No broad independent third-party runtime adoption was established by this search.

Decision consequence: optimize the first native release for a stable, documented protocol boundary and migration safety rather than preserving accidental private shapes. ACP support and generated schemas can widen integration without requiring consumers to embed Octocode internals.

## Evidence matrix

| System or standard | Primary evidence | Established capability | Octocode decision |
|---|---|---|---|
| OpenAI Codex | [`codex app-server`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) and [multi-agent handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents.rs) | Versioned app-server lifecycle, thread start/resume/fork, bounded transports/backpressure, generated schemas, streaming item progress, tool search, and managed subagents | Keep native RPC narrow, but add ACP as the editor interoperability surface; require bounds, schemas, and tool discovery on every machine protocol. |
| Gemini CLI | [ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md), [checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md), [model routing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model-routing.md), [worktrees](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/git-worktrees.md), and [subagents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md) | ACP-over-stdio, client-proxied filesystem, checkpoint restore, policy-aware fallback routing, isolated worktrees, and restricted-context specialist agents | Add ACP, explicit model-routing policy, and reviewable checkpoint UX. Existing Awareness/worktree and worker requirements remain the authority rather than copying Gemini storage. |
| OpenCode | [ACP agent implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/agent.ts) and [permission rules](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx) | ACP session list/resume/close/fork/config, granular allow/ask/deny rules, external-directory guards, and per-agent overrides | ACP must cover the stabilized session lifecycle. Octocode keeps its effect-ledger policy model and maps ACP permission requests into it. |
| Qwen Code | [subagent manager](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/subagents/subagent-manager.ts) and [fork design](https://github.com/QwenLM/qwen-code/blob/main/docs/design/fork-subagent/fork-subagent-design.md) | Configurable subagent catalog, validation, overrides, forked context, and extensive lifecycle tests | Preserve the existing A-* worker ledger and Awareness scheduler; add explicit catalog provenance and context-budget requirements rather than a second scheduler. |
| goose | [subagent tutorial](https://github.com/aaif-goose/goose/blob/main/documentation/docs/tutorials/subagents.md) | Role-specialized parallel delegation and headless composition | The existing dependency-aware bounded scheduler covers this; acceptance must prove non-overlapping ownership and deterministic reconciliation. |
| Aider | [repository map](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md) | Token-budgeted symbol/call-signature map ranked by dependency relevance | Add a semantic context-map requirement backed by Octocode AST/LSP rather than sending a static whole-repository dump. |
| Cline | [checkpoints](https://github.com/cline/cline/blob/main/docs/core-workflows/checkpoints.mdx) | Persistent shadow snapshots, diff review, and independent file/task restore | Extend S-06 with a user-visible compare/restore flow and separate file, conversation, and combined rollback semantics. |
| MCP | [2025-06-18 specification](https://modelcontextprotocol.io/specification/2025-06-18/index), [2025-11-25 tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks), and [tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks) | Capability-negotiated tools/resources/prompts, sampling, roots, elicitation, progress/cancellation, and evolving durable tasks | Implement the stable core capabilities in RUN-203; isolate durable tasks behind a pinned extension/version adapter because the task design is still evolving. |
| ACP | [official introduction](https://agentclientprotocol.com/get-started/introduction) and [protocol updates](https://agentclientprotocol.com/updates) | Editor-agent JSON-RPC, filesystem/terminal capabilities, structured progress, modes/config, and stabilized session list/resume/close | Ship an ACP agent endpoint after native sessions and policy are production-composed. Do not invent an Octocode-specific editor protocol. |
| A2A | [official specification](https://a2a-protocol.org/dev/specification/) | Agent cards, stateful tasks, streaming, resubscription, artifacts, and push notifications | Defer an internet-facing A2A gateway. Internal coordination remains Awareness-owned; add A2A later as an optional transport/plugin only with auth, tenancy, and remote-operation requirements. |
| AGENTS.md | [open format](https://agents.md/) | Hierarchical repository instructions with nearest-file precedence | Make instruction discovery, provenance, trust, precedence, deduplication, and context cost explicit in the runtime contract. |

## AST and LSP receipts

Sparse source materialization was limited to the relevant implementation subtrees. Structural search and LSP established:

- Gemini's `GeminiAgent` is a production ACP dispatcher referenced by its stdio transport and ACP tests (`packages/cli/src/acp/acpRpcDispatcher.ts:21`; nine references across four files).
- OpenCode's ACP `Agent` structurally implements initialize, authentication, new/load/list/resume/close/fork, configuration, prompt, and cancellation methods (`packages/opencode/src/acp/agent.ts:32-86`).
- Qwen Code's `SubagentManager` is exported through the package and exercised by extensive manager tests (23 references across four files).
- Aider's `RepoMap` is a concrete code owner, not documentation-only prior art (`aider/repomap.py:42`; LSP resolves the declaration and internal use).
- Local `NATIVE_MODEL_PROTOCOL_SUPPORT` is production-referenced by `launcher.ts` and tests, while the 2026-08-28 snapshot marks only Chat Completions supported (`packages/octocode-agent/src/native-model.ts:18-24`; six references across three files).
- Local `ApiFamily` declares several provider families but has no production consumer outside its defining contract (`packages/octocode-agent-core/src/contracts/models.ts:2`; two same-file references).
- Local `SemanticWidgetController` is production-reachable from the OpenTUI renderer and tests (19 references across three files), and `FileSettingsStorage` is reachable from the native launcher/settings path (10 references across five files).

## Accepted feature delta

The feature ledger expands from 100 to 108 stable IDs:

- `R-13` context governance and cache-friendly prompt composition;
- `R-14` hierarchical instruction/config discovery;
- `R-15` policy-controlled model routing and fallback;
- `T-13` ACP editor-agent interoperability;
- `T-14` dynamic tool discovery and deferred schemas;
- `T-15` semantic AST/LSP context map;
- `T-16` versioned MCP durable tasks;
- `U-16` checkpoint, diff, and selective restore UX.

All eight enter as declared requirements. None raises implementation or cutover readiness. A2A remains a documented deferred option, not a hidden release blocker.

## Rejected shortcuts

| Option | Decision | Reason |
|---|---|---|
| Do nothing | Reject | Leaves an editor-integration gap and keeps context/tool growth implicit. |
| Invent an Octocode editor wire protocol | Reject | ACP already supplies a cross-editor contract and active implementations. |
| Implement ACP, A2A, and every MCP draft in one cutover | Reject | Couples local editor migration to remote-agent tenancy and unstable extensions. |
| Copy competitor storage/schedulers | Reject | Octocode already has native session contracts and Awareness as coordination authority. |
| Add the bounded eight-feature delta | Accept | Closes demonstrated gaps while preserving ownership and staged verification. |

## Refresh rule

Recheck repository heads and protocol revisions before implementation begins. Pin ACP SDK/schema, MCP core revision, and MCP tasks-extension revision in the implementation receipt; do not infer compatibility from package names or latest tags.
