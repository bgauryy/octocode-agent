# Mandatory test plan: Remove `pi-coding-agent`

> Requirements: `RFC.md` §Goals and non-goals. Operational order: `STEPS.md`. Maturity and feature IDs: `READINESS_AND_FEATURE_MATRIX.md`. Stages: `MIGRATION_STAGES.md`. Types and schemas: `SCHEMAS_AND_TYPES.md`. Hooks/plugins: `HOOKS_AND_PLUGINS.md`. Native terminal: `OPENTUI_TERMINAL_CORE.md`. Unified settings: `SETTINGS_WEB_UI.md`. Targets and decision rules: `KPI.md`. Comparison schema: `BEFORE_AFTER.md`.

## Test policy

Testing is mandatory at every migration stage. Passing compilation or one host-specific suite is insufficient. Each behavior-changing stage must provide:

1. unit tests for its owned state and errors;
2. contract tests that run the same scenario against Pi and Octocode adapters;
3. integration tests through built package boundaries;
4. fault and negative security tests;
5. a real-path smoke test for every affected mode;
6. before/after evidence with exact commands and exit codes.

A stage fails when a required test is skipped without an owner-approved reason and expiration trigger.

The 2026-08-28 [integrated runtime closure](evidence/integrated-runtime-closure-2026-08-28.md) remains an immutable baseline. The current 2026-08-29 dirty-tree gate passes 3,687 root tests plus package-install, real-PTY restoration, lossless Unicode streaming, SIGINT/SIGTERM cleanup, and guarded performance sensors. These receipts are inputs to this plan, not substitutes for the clean candidate, credentialed-provider, cross-platform, real Pi/native, canary, or rollback matrices.

## Test environments

| Dimension | Required coverage | Recording rule |
|---|---|---|
| Commit/tree | Named before and after commits; dirty state recorded | Include SHA and `git status` summary |
| Node/Yarn | Repository-supported versions | Record exact versions |
| OpenTUI runtime | Accepted Bun 1.3+ or Node.js 26.4+ experimental-FFI route | Record runtime, flags, OpenTUI version, native package, architecture, and libc where applicable |
| Operating system | Every supported release platform | Record OS version and architecture |
| Terminal | Supported interactive terminals plus headless | Record terminal type, dimensions, color/image capability |
| Browser/settings | Supported local browser path plus HTTP-level headless client | Record browser/runtime, CSP, origin, token, and page revision |
| Mode | Interactive, print, JSON, RPC | Every candidate runs all four |
| Trust | trusted, untrusted, undecided where supported | Negative cases required |
| Session | new, resume, fork, tree, imported Pi, corrupted fixture | Use synthetic/redacted corpus |
| Model | Deterministic mock for gates; one approved live-provider smoke | Never use live calls for golden equality |
| Network | offline/mock and approved integration access | Record whether network was available |
| Feature selection | Pi, pure shadow, native | Never run effectful shadow twice |
| Hooks/plugins | user, trusted project, managed, plugin; command/MCP/async; enabled/disabled/review-required | Record definition/manifest hashes, event, host, decision, and redaction counts |

## Fixture and oracle rules

- Use `@octocodeai/agent-testing` as the shared deterministic scenario harness after its package boundary passes review.
- Treat live Pi/RPC traces as behavior evidence, not as a license to copy incidental fields.
- Normalize timestamps, random IDs, temporary absolute paths, provider request IDs, ANSI style, and secret-bearing fields.
- Preserve event order, error category, command/tool names, policy decisions, session ancestry, exit codes, and effect IDs.
- Store raw fixtures separately from normalized fixtures and hash both.
- Use synthetic or irreversibly redacted session content.
- Fail on exhausted scripted responses, duplicate registration, unknown operations, blocked calls, and pre-cancelled execution.
- Review fixture changes like public contract changes: show the first semantic difference, rationale, impact, and owner.

## Required suite inventory

| Suite | Before host | After host | Required stage | Pass rule |
|---|---|---|---:|---|
| Contract types | Pi adapter | Native implementation | 1+ | No product Pi types outside adapter |
| Schema/type consistency | Pi adapter and agent core | Native implementation | 1+ | Canonical schema/type drift check passes |
| Pi-extension version matrix | Supported Pi hosts | Same adapter over agent core | 1-7 | Activation and semantic conformance pass for every supported version |
| Tool registry/execution | Pi | Native | 1-7 | Same approved inventory and semantics |
| Command registry/execution | Pi | Native | 1-7 | Same approved inventory and permissions |
| Lifecycle ordering | Pi | Native | 1-7 | Required sequence and transforms match |
| Codex hooks compatibility | Codex-format fixture oracle and Pi adapter | Native loader/dispatcher | 1-7 | Exact supported JSON/TOML discovery, matcher, input/output, decision, trust, and async fixtures pass |
| Plugin lifecycle/contributions | Pi adapter over canonical registries | Native plugin manager | 2-7 | Transactional activation/unload, deterministic inventory, permissions, and zero leaks |
| Policy/security | Pi | Native | 1-7 | Zero bypass |
| Prompt snapshots | Pi | Native | 2-7 | Zero unapproved semantic drift |
| Session import/replay | Pi source | Native destination | 3-7 | No loss/reordering; source unchanged |
| Branch/fork/tree/rewind | Pi | Native | 3-7 | Same ancestry and leaf selection |
| Compaction | Pi | Native | 3-7 | Same reason class; one valid terminal state |
| Runtime turn/model/tool | Pi | Native | 4-7 | Same normalized deterministic trace |
| Cancellation/leaks | Pi | Native | 4-7 | One terminal state; zero owned children |
| UI semantics | Pi shell/TUI | Native UI adapter | 5-7 | Critical semantic events preserved |
| OpenTUI projection/renderer | Pi semantic baseline | `@opentui/core` adapter and test renderer | 0, 5-7 | Runtime/package spike plus frame, input, lifecycle, accessibility, and PTY gates pass |
| Settings registry/HTML | Existing eight-section page and direct writers | Unified native and Pi-extension page | 1, 5-7 | Every supported setting renders/classifies; identical effective values and typed mutations |
| Models/`models.json` | Pi defaults and compatibility sources | Canonical catalog/store plus import adapters | 1, 5-7 | Default/catalog/CRUD/import/diff/conflict/atomicity/redaction suites pass |
| Ask/Plan/Delegate/Configure | Supported Pi projections | Native production control-plane owners | 2-7 | Same approved semantics and authority split; no parallel store or bypass |
| Connections/MCP Tasks | Supported Pi MCP adapter | Native MCP adapter plus Configure → Connections projection | 4-7 | Negotiation, auth, task state, cancellation, recovery, redaction, and information architecture pass |
| Print | Pi runner | Native adapter | 5-7 | Same normalized output and exit code |
| JSON/RPC | Pi protocol | Native/compatibility adapter | 5-7 | Schema and corpus pass |
| Packaging/dependencies | Pi artifact | Native artifact | 6-7 | Target dependency/reference counts |
| Performance/reliability | Pi baseline | Native cohort | 4-7 | Approved thresholds and sample sizes |

## Unit tests

### Runtime contracts and lifecycle

- Verify every new production runtime module lives under `packages/octocode-agent-core/` or is an explicitly approved consumer/adapter.
- Verify agent core does not import `packages/octocode-agent`, `packages/octocode-pi-extension`, or terminal UI packages.
- Verify the Pi extension imports canonical agent-core contracts and does not redeclare them.
- Verify schema/type generation or equivalence checks are deterministic.
- Validate every discriminated event variant and reject unknown protocol versions at external boundaries.
- Verify middleware priority, stable order, transformation composition, blocking, timeout, cancellation, and error attribution.
- Verify lifecycle state transitions reject illegal double-start, double-end, and post-terminal events.
- Verify execution contexts expose only approved immutable fields and capabilities.

### Tools and commands

- Snapshot tool names, descriptions, schemas, policy metadata, and active defaults.
- Verify argument preparation runs before validation/execution in the approved order.
- Verify update, success, error, and cancellation results.
- Verify duplicate tool/command registration fails.
- Verify command-only session operations cannot run from tool/event contexts.
- Verify argument completion and command discovery.

### Hooks, events, and plugins

- Load exact Codex `hooks.json`, inline TOML, user/project/managed/plugin merge, aliases, wildcard/empty/omitted matchers, and preserved unsupported definitions.
- Cover every supported Codex lifecycle event and every production-used Pi event mapping with ordered native/Pi traces.
- Verify stable ordering, deny-wins permission aggregation, supported rewrite composition/revalidation, stop scope, handler errors, cancellation, and no recursion.
- Verify command JSON stdin/output, platform command selection, minimal environment, exit classification, timeouts, descendants, spill limits, cleanup, and redaction.
- Verify MCP server/tool selection, typed template expansion, missing paths, unavailable connection, timeout, output validation, and no nested hooks/approval.
- Verify async handlers cannot block/approve/rewrite, respect per-session concurrency, deliver only at safe points, and cancel on session end.
- Verify workspace trust, exact-definition hash review, changed-hash invalidation, managed-only policy, plugin-path containment, and symlink defenses.
- Verify plugin manifest/API validation, capability grants, activation events, lazy activation, duplicate conflicts, transactional registration, reverse unload, active leases, update, and resume provenance.
- Exercise hook/tool/command/resource/MCP/setting/prompt/UI/model contributions through canonical registries, including denied high-risk capabilities.
- Verify the Hooks/Plugins HTML sections are complete, revision-safe, accessible, and free of raw commands, prompt/tool data, environment values, and secrets.

### Sessions and compaction

- Verify expected-revision append, atomic transaction, idempotent replay, and deterministic projection.
- Verify new, resume, switch, fork, tree, labels if approved, names, and custom entries.
- Verify custom entries stay outside model context.
- Verify manual, threshold, overflow, retry, failure, and cancellation compaction states.
- Verify truncated records, unknown versions, duplicate events, stale revisions, and interrupted writes.

### Prompt and model adapters

- Snapshot prompt bytes and normalized semantic segments.
- Verify model selection and thinking-level acceptance/rejection.
- Verify text, thinking, tool-call, usage, stop, retry, and provider-error normalization.
- Verify provider payloads and secrets do not leak into public events or logs.

### Native OpenTUI terminal

- Verify pure reducers project semantic runtime/UI events into immutable presentation state.
- Verify no `@opentui/core` type or import appears in agent core, Pi extension, print, JSON, RPC, or headless implementations.
- Use `@opentui/core/testing` for frames, input, mouse, resize, focus, clock, capability variants, and exactly-once renderer destruction.
- Verify keyboard-only navigation, visible focus, cancellation, color-independent severity, Unicode width, narrow-terminal behavior, and the approved alternate-output strategy.
- Verify streaming coalesces presentation-only updates without dropping interaction, approval, terminal runtime, or tool-result semantics.
- Verify failed initialization, normal exit, error, Ctrl-C, termination signal, resize, and crash paths restore the terminal.
- Verify noninteractive modes never initialize OpenTUI and preserve stdout/stderr protocol purity.
- Run real PTY tests on every supported platform, architecture, runtime route, and native artifact variant.

### Unified settings and models

- Snapshot every registered setting key, schema version, section/order, scope, default, provenance, mutability, application timing, redaction class, and owner.
- Fail when a human-facing setting lacks an HTML renderer or approved machine/secret-only classification.
- Verify stored and effective values, complete precedence, optimistic revisions, typed conflicts, and deterministic snapshots.
- Verify `/settings` and every deep link, especially `/settings models`, with keyboard and responsive-page accessibility checks.
- Verify default provider/model updates commit together and cannot select an unresolved effective model.
- Verify provider/model CRUD, compatibility fields, unknown/null metadata, catalog merging, refresh, dependency checks, and frozen-session warnings.
- Verify canonical and legacy `models.json` sources, import-only behavior, supported unknown-field preservation, semantic diff, atomic writes, permissions, backups, rollback, and external-edit conflicts.
- Scan generated HTML, DOM state, action payloads/responses, URLs, logs, diffs, backups, and receipts for synthetic secret markers.
- Verify native and every supported Pi-extension host expose identical canonical values; classify host-only settings explicitly.
- Verify agent core imports no HTML, browser, filesystem implementation, Pi, or OpenTUI type.

## Shared host-conformance scenarios

Run every scenario against the Pi compatibility adapter and native implementation:

1. Start session, register tools/commands/hooks, and stop cleanly.
2. Submit one deterministic prompt and capture the complete turn.
3. Stream text, thinking, tool-call arguments, tool updates, and result.
4. Block a tool by plan policy, workspace trust, approval, and peer lock.
5. Fail a tool before execution, during execution, and during result persistence.
6. Cancel before submit, during model stream, during tool work, and during compaction.
7. Send steer and follow-up input while streaming.
8. Start, name, resume, fork, navigate tree, rewind, export, and stop a session.
9. Compact manually, at threshold, on overflow, on retry, and on failed retry.
10. Exercise every semantic UI request with interactive and headless adapters, including Ask, Plan, Delegate, Configure, and MCP Tasks beneath Configure → Connections.
11. Run print, JSON, and RPC command/event corpora.
12. Restart after each persistence fault and verify one deterministic projection.
13. Load reviewed Codex hooks, dispatch every mapped lifecycle event, and compare decision/context/rewrite receipts.
14. Activate, use, disable, unload, update, and resume with a synthetic plugin while proving transactional contributions and zero owned resources.
The comparison reports the first divergence and the complete normalized trace hash.

Run the same semantic scenarios through the independently supported Pi extension against every declared version. Add adapter-specific cases for activation, unsupported-version failure, event mapping, context privilege narrowing, UI fallback, session identity, and renderer-only extensions. Native release closure retains these live extension tests and separately requires zero native Pi paths.

## Sealed held-out evaluation corpus

The release/test owner freezes `native-pi-isolation-v1` before the candidate run. Each family has at least one undisclosed concrete variant per applicable mode; the receipt contains only hashes until evaluation completes.

| Family | Held-out variation | Required invariant |
|---|---|---|
| Lifecycle | Start/stop interleaving with one listener failure | One legal terminal sequence; no post-stop event |
| Stream/tool | Chunk and tool-argument boundaries vary | Same normalized content, correlation, and result |
| Policy/effects | Trust, plan, lock, hook rewrite, and approval combinations | Same ordered decision; zero unregistered effect |
| Cancellation | Cancel during model, tool child, worker, and compaction boundaries | One terminal result; zero owned child |
| Sessions | Branched imported session with unknown/truncated records | Source unchanged; deterministic safe projection or typed rejection |
| Control plane | Ask timeout, Plan revision conflict, Delegate dead pipe, Configure revision conflict | Canonical owner resolves deterministically; no host-private bypass |
| Connections | MCP task auth/TTL/restart/cancel and cross-caller isolation | Task remains negotiated, scoped, durable, redacted, and under Connections |
| Output/platform | Malformed JSON/RPC plus narrow Unicode PTY crash | Protocol purity and exact terminal restoration |

The baseline runner has not executed this sealed corpus. Unsupported, skipped, quarantined, or fixture-mutated required cases fail the KPI.

## Mode matrix

| Behavior | Interactive | Print | JSON | RPC |
|---|---:|---:|---:|---:|
| Startup and clean stop | Required | Required | Required | Required |
| Prompt and streamed output | Required | Required | Required | Required |
| Steer/follow-up | Required | Not applicable | Required when exposed | Required |
| Cancellation | Required | Signal/timeout | Required | Required |
| Tool updates/results | Required | Final output | Required | Required |
| Commands/discovery | Required | Approved subset | Approved subset | Required |
| Session new/resume/fork/tree | Required | Approved subset | Required when exposed | Required |
| Compaction/retry | Required | Required when invoked | Required | Required |
| UI dialog/status/widget | Required | Headless fallback | Semantic event/fallback | Protocol request/response |
| OpenTUI initialization | Required | Forbidden | Forbidden | Forbidden |
| Open settings HTML | Required command/deep link | Approved URL-return/open behavior | Typed URL/event when exposed | Typed request/response when exposed |
| Malformed input | User-visible error | Nonzero exit | Typed error record | Correlated error response |
| Terminal/stdout restoration | Required | stdout/stderr | JSON-only stdout | JSONL-only stdout |

“Not applicable” requires a contract reason. It cannot hide an unimplemented required feature.

## Session migration tests

For each corpus entry:

1. Hash the original Pi file.
2. Parse and project it with the baseline Pi path.
3. Import it into a separate native destination.
4. Replay the native store from zero state.
5. Compare transcript, branch graph, selected leaf, custom-entry visibility, compaction state, name, and artifact references.
6. Restart and repeat the native projection.
7. Confirm the original Pi hash is unchanged.
8. Export diagnostics that contain no private raw content.

The corpus must cover empty, large, non-ASCII, branched, compacted, aborted, truncated, unknown-entry, and cross-platform path cases listed in `KPI.md`.

## Fault-injection tests

| Fault | Injection point | Required result |
|---|---|---|
| Process exits | Before runtime ready, during turn, during tool | Typed terminal failure; owned children stop |
| Provider disconnects | Before first delta and mid-stream | Classified retry/failure; no duplicate turn |
| Tool throws | Before update and after update | One error result and terminal lifecycle event |
| Cancellation races | Submit/start/update/end boundaries | One terminal state; no late effect |
| Session write fails | Before append, partial write, commit boundary | Prior revision remains readable |
| Stale revision | Concurrent append | Explicit conflict; no silent overwrite |
| Import record malformed | Middle and final record | Typed failure or approved salvage; source unchanged |
| Compaction fails | Prepare, write, retry, continuation | No loop; durable state retained |
| RPC frame malformed | Invalid JSON, unknown type/version, oversized line | Correlated/typed rejection; runtime remains healthy |
| UI unavailable | Dialog and custom-render paths | Approved fallback or explicit failure without deadlock |
| OpenTUI initialization/render failure | Before terminal enter, after enter, during frame, during interaction | Typed failure, no runtime corruption, exactly-once cleanup, terminal restored |
| Settings/model write fails | Validation, expected revision, temporary write, rename, catalog rebuild | No partial commit; typed conflict/failure; prior effective snapshot remains valid; recovery path available |
| Hook handler fails | Spawn, stdin, parse, timeout, cancellation, output spill, redaction | Event-specific fail-closed/isolation result; one receipt; no descendant/temp leak |
| Plugin activation/unload fails | Validation, contribution N, ready transition, active lease, cleanup | No partial visible registry; reverse cleanup; typed disabled/failed health |

## Security tests

- Execute every mutation-capable tool through interactive, print, JSON, and RPC entry points.
- Verify untrusted and undecided workspaces cannot inherit a trusted default.
- Verify plan-mode and peer-lock denials happen before any file/process effect.
- Verify noninteractive approval policy is explicit and fail-closed.
- Verify path traversal, symlink, import/export destination, and session identifier adversarial cases.
- Verify logs, events, fixtures, errors, and evidence receipts redact configured secrets.
- Verify malformed provider/tool payloads cannot inject internal lifecycle events.
- Verify RPC version/type confusion cannot reach tool execution.
- Verify settings actions reject DNS rebinding, invalid origin/token, CSRF, traversal, symlinks, oversized bodies/collections, malicious model metadata, and untrusted workspace writes.
- Verify raw credentials cannot enter normal model forms or any browser-visible/generated/evidence surface.
- Verify untrusted/changed hooks and plugins never execute; enabling never implies trust; managed-only policy cannot be overridden.
- Verify hook/plugin output cannot forge lifecycle events, widen permissions, bypass trust/approval/plan/locks, inject registry entries, traverse paths, or leak protected environment/secrets.

Any bypass fails the stage regardless of other results.

## Performance and reliability tests

Use fixed hardware or a recorded equivalent environment and the same deterministic corpus. Record warmup policy, repetitions, sample count, p50, p95, maximum, and confidence interval where applicable.

| Metric | Start measurement | End measurement | Gate source |
|---|---|---|---|
| Cold/warm startup | Process start to runtime ready | Same | `KPI.md` approved threshold |
| First visible event | Accepted input to first event | Same | Approved threshold |
| Turn completion | Accepted input to terminal event | Same mocked stream | Approved threshold |
| Session append | Append start to committed revision | Same event batch | Approved threshold |
| Import/replay | Fixture start to projection | Same corpus | Approved threshold |
| Peak RSS | Representative session/turn | Same corpus | Approved threshold |
| OpenTUI first frame/frame duration | Renderer creation to first frame; sustained deterministic stream | Same terminal dimensions and presentation corpus | `KPI.md` approved threshold |
| Cancellation | Cancel request to terminal state | Same scenario | Zero leak plus threshold |
| Reliability | Success/error/cancel by scenario | Canary cohort | No significant regression |

Do not combine unlike model/provider/network runs into one latency comparison.

## Build and command verification

The canonical receipt must run the repository-documented commands rather than inventing alternate build paths:

```text
yarn workspace @octocodeai/octocode-awareness build
yarn workspace <agent-core-workspace-name> test
yarn workspace <agent-core-workspace-name> build
yarn workspace @octocodeai/pi-extension build
yarn workspace @octocodeai/agent-testing test
yarn workspace octocode-agent build
yarn test
yarn lint
yarn typecheck
```

After package changes, run the real local paths documented in `AGENTS.md`: Octocode CLI help/context/catalog/schema checks, `octocode-agent` interactive smoke, print smoke, JSON/RPC smoke, session import/resume, and the relevant MCP/skill path.

Phase 1 selects the agent-core workspace name in its manifest. Replace `<agent-core-workspace-name>` in the evidence receipt with that verified name. If another manifest exposes different workspace names or scripts at implementation time, record the verified command and update this document before proceeding.

## Stage test gates

| Stage | Minimum mandatory tests |
|---:|---|
| 0 | Complete Pi baseline, static inventory, fixtures, focused harness tests |
| 1 | Contract types, Pi adapter, shared harness, dependency-cycle check, Codex hook schema fixtures |
| 2 | Tools, commands, lifecycle, hooks/plugins, prompt, policy/security, helper extraction |
| 3 | Sessions, migrations, projections, corruption, compaction, restart |
| 4 | Runtime/model/tool loop, cancellation, leak, stress, pure shadow |
| 5 | Full mode/UI/protocol/platform matrix, including Hooks/Plugins settings and host conformance |
| 6 | Complete candidate suite, canary metrics, tested rollback |
| 7 | Native zero-reference/dependency proof, rebuilt artifact, all real-path smokes, and supported Pi-extension matrix |

## Test evidence receipt

Every stage receipt contains:

| Field | Required value |
|---|---|
| Stage and decision | Proceed, hold, or rollback |
| Commit and tree state | SHA and dirty summary |
| Environment | Toolchain, OS, architecture, mode, host |
| Commands | Exact command and exit code |
| Results | Suites, tests, failures, skips, duration |
| Fixtures | Raw and normalized hashes |
| Static checks | Queries, tool versions, counts, paths |
| Differences | First divergence, impact, owner decision |
| Guardrails | Security, duplicate effects, data loss, loops, leaks |
| Performance | Samples and approved threshold decision |
| Approvals | Runtime, session, security, transport, release as required |

## Release test sign-off

The release candidate passes only when:

- all required suites and real paths pass on the named candidate artifact;
- all required platforms/modes pass or have an approved support-scope change;
- native agent/core `pi-coding-agent` references and dependency paths equal zero;
- extension-owned Pi references match the approved package/test/publication inventory, while native source, manifests, dependency tree, built/packed artifacts, installers, updates, selectors, fallbacks, and rollback paths contain zero Pi references;
- session source hashes remain unchanged after import;
- security bypasses, duplicate effects, unrecoverable migrations, compaction loops, and owned-child leaks equal zero;
- performance and reliability meet approved baseline-derived thresholds;
- every accepted difference has a user-impact assessment and owner approval;
- rollback has been executed successfully against the candidate artifact;
- the signed after/comparison receipts exist under this RFC folder.
