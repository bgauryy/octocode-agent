# Implementation Sequence

Status: required execution order  
Scope: dependency-ordered implementation, verification, rollout, and complete native Pi retirement
Invariant: native agent/core and release artifacts remain Pi-free; `@octocodeai/pi-extension` remains an independently installed, version-pinned Pi compatibility product

## Sequence principle

Build from invariant-owning foundations toward user-facing composition. A type,
class, isolated adapter, synthetic fixture, or passing unit test does not close a
phase until the production launcher reaches it and the same semantic scenario
runs through the real Pi and native adapters.

Each phase has four states:

1. **Implemented** — behavior exists behind owned contracts.
2. **Composed** — the production entry point reaches it without a bypass.
3. **Verified** — focused, production-path, and real-host gates pass.
4. **Accepted** — the named entry/exit decision and receipt are signed.

No later phase may reinterpret an unmet earlier gate as verification debt.
Continuous conformance is required in every phase; the final conformance phase
expands the matrix but does not introduce real adapters for the first time.

## Mapping overview

| Design phase                          | RFC Steps | Migration Stages | Primary dependency                                 |
| ------------------------------------- | --------- | ---------------- | -------------------------------------------------- |
| 0. Truth and decisions                | 0–2       | 0                | Approved baseline, owners, route, evidence policy  |
| 1. Runtime ownership and transports   | 3–4, 6    | 1–2, 4           | Canonical contracts and joined execution ownership |
| 2. Canonical startup state            | 5–6, 8    | 2–5              | Session projection, settings, trust, model catalog |
| 3. Pre-effect pipeline and hooks      | 4, 7      | 2, 5             | One intercepting security/effect boundary          |
| 4. Provider, tools, durable sessions  | 5–6       | 3–4              | Correct context, effects, persistence, retries     |
| 5. Plugins and settings control plane | 7–8       | 2, 5             | Grants, contributions, leases, shared settings     |
| 6. OpenTUI interaction system         | 9         | 5                | Stable runtime/UI ports and headless isolation     |
| 7. Full conformance and rollout       | 10        | 5–6              | Composed vertical slices and continuous comparison |
| 8. Native Pi dependency removal       | 11–12     | 7                | Observation window and artifact rollback           |

The mapping is many-to-many because RFC Steps describe deliverables while
Migration Stages describe acceptance boundaries. A phase closes only when every
mapped owning requirement in scope for that phase has evidence.

## Continuous real-host conformance rule

At the start of Phase 1, create production conformance adapters for:

- the actual frozen Pi-oracle/host composition; and
- the actual native launcher/kernel composition.

Every phase adds scenarios to the same corpus and runs them in the modes
supported at that point:

- **Pure:** deterministic adapters, no external effects.
- **Shadow:** candidate proposes effects, and one shared ledger blocks them.
- **Live:** exactly one named host executes each approved effect.

Normalization may replace nondeterministic representation, but it must preserve
identity equality, request/effect correlation, event ordering, session ancestry,
selected leaves, error categories, policy decisions, and meaningful paths. Each
receipt records the first semantic divergence. Synthetic handlers may unit-test
the runner but never satisfy a phase conformance gate.

## Phase 0 — Freeze truth and decisions

**Maps to:** RFC Steps 0–2; Migration Stage 0.

### Entry gate

- RFC scope and the independent Pi-extension boundary are accepted.
- Candidate baseline SHA and evidence/privacy protocol are identified.
- Runtime, security, session, terminal, settings, testing, release, and rollback
  owners are accountable.

### Work

- Adopt `08-TRACEABILITY-CHECKLIST.md` as the completion ledger.
- Mark every item declared, implemented, composed, verified, or cutover-ready.
- Capture the canonical before receipt, normalized fixtures, hashes, environment
  matrix, supported Pi policy, and known failures.
- Approve the OpenTUI runtime/package/platform route.
- Define rollout thresholds, canary cohort, observation window, rollback window,
  artifact compatibility policy, and zero-tolerance failures.
- Inventory and pin the independent Pi adapter separately from native dependencies so
  native cleanup cannot remove or absorb its package, tests, docs, or publication path.

### Continuous conformance gate

- Freeze the real Pi baseline adapter, package/version identity, and initial
  semantic corpus.
- Record that the native adapter is incomplete rather than manufacturing parity.

### Exit gate

- Every RFC requirement has an owner, production path, test path, and gate.
- The canonical before receipt is reproducible and independently approved.
- No unresolved critical decision is hidden behind implementation work.

## Phase 1 — Runtime ownership and transport foundation

**Maps to:** RFC Steps 3–4 and the runtime-ownership portion of Step 6;
Migration Stages 1–2 and the runtime foundation of Stage 4.

### Entry gate

- Phase 0 is accepted.
- Agent-core package and one-way dependency boundary are approved.
- Runtime command/event/error schemas have version and validation owners.

### Work

- Introduce runtime-owned scopes for runtime, turn, provider request, tool, hook,
  plugin, compaction, and transport work.
- Implement legal state transitions, exactly-once turn/runtime terminal events,
  listener isolation, persistence failure policy, and joined idempotent shutdown.
- Make idle/active cancellation, submit, steer, follow-up, queueing, and rejection
  distinct canonical behaviors.
- Validate commands at the external boundary before dispatch.
- Make interactive and RPC command pumps receive controls while a turn streams.
- Subscribe print, JSON, and RPC before start and remain through stop.
- Correct RPC correlation, command-specific schemas, nested success/failure,
  protocol errors, stdout/stderr purity, and exit semantics.
- Add stable runtime/session/turn/request/call/effect correlation identities.

### Continuous conformance gate

- Run real Pi/native lifecycle, start/stop, input, cancellation, steering,
  follow-up, and print/JSON/RPC ordering scenarios.
- Candidate effects remain disabled; differences are explicit and reviewed.

### Exit gate

- No event occurs after `runtime.stopped`; active work is joined.
- Listener, persistence, validation, and transport failures reach one typed
  terminal state without stranding the runtime.
- Steering/follow-up/cancel work during streaming.
- All transports emit approved lifecycle and correlated failure shapes.

## Phase 2 — Canonical startup state, session projection, and settings

**Maps to:** the projection/context portion of RFC Step 5, composition portion of
Step 6, and service foundation of Step 8; Migration Stages 2–5.

### Entry gate

- Phase 1 runtime state and transport contracts are verified.
- Session projection and settings/model catalog schemas are approved.
- Trust and workspace identity sources have fail-closed ownership.

### Work

- Compose immutable startup inputs: mode, workspace identity, trust, managed
  policy, session projection, prompt inputs, settings snapshot, effective model
  catalog, cancellation root, and semantic UI/headless port.
- Separate transcript, model-context, custom, diagnostic, and compacted
  projections with deterministic visibility.
- Make new/resume/continue/switch load and validate projection before input.
- Initialize the model loop from projected history so resumed and uninterrupted
  requests are semantically equal.
- Make `--no-session` use an in-memory store and leave no session artifact.
- Compose one typed `SettingsRegistry`/`SettingsService` with transactional
  storage; native CLI and Pi adapter become clients of the same service.
- Resolve startup provider/model/thinking through the effective catalog, with
  provenance and redacted diagnostics.
- Dynamically select terminal dependencies only after interactive mode is known;
  headless startup must not import OpenTUI/FFI code.

### Continuous conformance gate

- Compare real Pi/native new, resume, continue, switch, no-session, prompt,
  effective settings, model selection, and all four mode scenarios.
- Capture the first request after resume under deterministic model control.

### Exit gate

- Resumed context equals uninterrupted context under the canonical normalizer.
- Settings/model/trust/session state has one production source and typed
  provenance; raw or secret-shaped values do not leak.
- No-session and every headless mode pass artifact/import-isolation checks.

## Phase 3 — Pre-effect pipeline and executable hooks

**Maps to:** RFC Step 4 and Step 7; Migration Stage 2 and the hook/security portion
of Stage 5.

### Entry gate

- Runtime scopes, startup trust/settings, and command validation pass.
- Tool effect taxonomy, approval, plan, and peer-lock inputs are defined.
- Dated Codex hook fixtures and review-hash policy are accepted.

### Work

- Implement one pipeline used by every effect path:

  ```text
  prepare -> validate -> resolve effect set
    -> eligible context/rewrite hooks -> restart after rewrite
    -> trust/managed policy -> plan -> peer locks
    -> blocking hooks -> restart every gate after rewrite
    -> final-bound approval -> shared ledger/owned scope -> execute
    -> validate/redact/persist/emit
  ```

- Implement native hook discovery, precedence, hash review, matchers, command and
  synchronous MCP execution, typed decisions, timeouts, cancellation, output
  bounds/spill, and redaction.
- Bind approval to the validated argument/effect digest and invalidate it after
  a rewrite.
- Require conservative composite effect classification for mixed network,
  filesystem, process, or write behavior.
- Route CLI, RPC, hook, plugin, retry, resume, migration, and internal helper
  effects through the same boundary.

### Continuous conformance gate

- Run real Pi/native trust, approval, plan, peer-lock, hook block/rewrite/context,
  timeout, and cancellation scenarios in pure and shadow modes.
- One shared cross-host ledger proves no external effect executes in shadow.

### Exit gate

- A reviewed real hook blocks and rewrites a real native tool call before effect.
- Missing trust, plan, lock, hook review, or approval fails closed when required.
- No registered or unregistered effect path bypasses the pipeline.

## Phase 4 — Provider, tools, and durable sessions

**Maps to:** RFC Steps 5–6; Migration Stages 3–4.

### Entry gate

- Phase 2 supplies projected context and effective model state.
- Phase 3 owns all effect execution.
- Storage, migration, compaction, provider retry, and tool validation decisions
  are approved.

### Work

- Assemble canonical prompts from trusted provenance-bearing fragments and
  model-visible history.
- Implement provider/catalog routing, thinking translation, strict streaming and
  nonstreaming parsing, incremental tool-call assembly, typed stop/error/usage,
  cancellation, and bounded classified retry.
- Prepare and validate tool input before policy and after rewrite; validate
  updates/results before persistence or emission.
- Correlate assistant tool calls/results and prevent duplicate effects across
  retries, reconnects, and resume.
- Implement cross-process linearizable session commits, full envelope/graph
  validation, backup/temp/lock recovery, and typed durability failures.
- Implement name, switch, fork-at-entry, tree, rewind, export, and transactional
  byte-preserving Pi import.
- Persist recoverable assistant streaming checkpoints.
- Integrate durable, cancellable, repeatable, finite-retry compaction for manual,
  threshold, and overflow triggers.

### Continuous conformance gate

- Run real Pi/native deterministic turn, streaming text/thinking/tool, provider
  failure/retry, tool effect, session lifecycle, migration, restart,
  branch/rewind/export, and compaction scenarios.
- Live scenarios designate exactly one effect executor.

### Exit gate

- Streaming and nonstreaming responses normalize to the same semantics.
- Invalid provider/tool data never reaches an effect executor.
- Concurrent writers cannot lose a commit; fault injection yields an old or new
  valid record, never a mixed record or silent success.
- Resume, migration, branching, partial-stream recovery, and every compaction
  terminal/retry case pass.

## Phase 5 — Plugins and settings control plane

**Maps to:** RFC Steps 7–8; Migration Stages 2 and 5.

### Entry gate

- Phase 2 settings service is production-composed.
- Phase 3 effect/hook boundary is verified.
- Plugin manifest, capability, contribution, lease, trust, path, and update
  policies are approved.

### Work

- Implement plugin discovery and versioned manifests with normalized realpath
  containment and manifest hashes.
- Bind grants to plugin ID, manifest hash, revision, scope, permissions, expiry,
  and explicit denial.
- Permit only manifest-declared, grant-authorized, owner-correct contributions.
- Compose transactional activation, reverse rollback, leases, bounded work
  drain/cancel, disable, unload, update, and resume provenance.
- Connect plugin and hook state to the canonical settings service.
- Complete revision-safe, redacted Models, Hooks, Plugins, MCP, Skills, commands,
  connections, diagnostics, provenance, diff, impact, and rollback projections.
- Make native CLI/browser and the frozen Pi oracle consume the same canonical
  snapshots and typed mutations through host-specific adapters.

### Continuous conformance gate

- Run real Pi/native hook/plugin discovery, activation, use, failure rollback,
  update, disable/unload, settings conflict, trust, and redaction cases.

### Exit gate

- No undeclared, ungranted, expired, owner-spoofed, or escaping contribution can
  commit.
- Failed activation/update preserves previous active state.
- Unload requires zero live leases and leaves zero owned resources.
- Native and Pi settings adapters produce equivalent canonical results.

## Phase 6 — OpenTUI interaction system

**Maps to:** RFC Step 9; Migration Stage 5.

### Entry gate

- Runtime concurrency/shutdown, semantic `UiPort`, settings, hooks, approvals,
  sessions, and transports are stable.
- OpenTUI package/runtime/platform route is approved.

### Work

- Replace the text-renderer/readline split with one OpenTUI-owned editor and
  interaction pump.
- Implement transcript, thinking, tools, progress/results/errors, header/footer,
  widgets, statuses, notifications, overlays, and settings entry points.
- Implement submit, steer, follow-up, cancel, approval, confirm, select, input,
  editor, focus, keymaps, mouse, resize, clipboard, Unicode, capabilities, and
  accessibility behavior.
- Queue/coalesce presentation without dropping semantic state.
- Implement exactly-once teardown/restoration on normal exit, init/render
  failure, cancellation, signal, and crash boundaries.
- Preserve interactive-only loading; every headless/support command remains
  OpenTUI-free.

### Continuous conformance gate

- Run real Pi/native semantic UI traces plus native test-renderer and real-PTY
  scenarios while headless modes prove isolation.

### Exit gate

- Every interaction works through `UiPort`, not parallel readline.
- PTY restoration, narrow terminal, Unicode/RTL/wide glyph, mouse/focus/resize,
  capability, accessibility, performance, package, and platform matrices pass.
- Headless import/protocol checks prove zero OpenTUI initialization.

## Phase 7 — Full conformance, shadow, canary, and rollout

**Maps to:** RFC Step 10; Migration Stages 5–6.

### Entry gate

- Phases 1–6 are composed and incremental real-host scenarios pass.
- Canary thresholds, cohort, observation window, instant-disable mechanism, and
  artifact/session rollback are approved.
- A clean committed native candidate and canonical after receipt exist.

### Work

- Run the complete corpus through production Pi/native adapters in pure and
  shadow modes with one cross-host effect ledger.
- Run designated live-effect, security, fault, performance, package, upgrade,
  PTY, browser/settings, session, and supported-platform matrices.
- Produce signed before/after semantic, performance, security, dependency, and
  user-impact comparisons.
- Ship shadow, then explicit canary with immediate rollback.
- Observe the approved window and resolve every critical/high mismatch.
- Exercise rollback using actual release artifacts and persisted sessions.

### Continuous conformance gate

- Run the union of all earlier scenarios without retroactively waiving receipts.
- Duplicate/unregistered effect, bypass, data loss, protocol corruption,
  restoration failure, compaction loop, or rollback failure forces hold.

### Exit gate

- Native default meets every threshold for the full observation window.
- Every platform passes install, upgrade, package, PTY, settings, provider,
  session, and rollback gates.
- Signed comparison approves native dependency removal.

## Phase 8 — Remove native Pi dependencies and close the window

**Maps to:** RFC Steps 11–12; Migration Stage 7.

### Entry gate

- Phase 7 is accepted and the observation window passed.
- Artifact rollback is proven and available for the approved window.
- Exact native-only dependency/reference inventory is approved.

### Work

- Remove Pi-family imports, resolution, subprocess launch, fallback,
  compatibility configuration, and obsolete native tests/docs from
  `octocode-agent` and agent core.
- Verify source, manifest, dependency tree, built JavaScript, packed artifact,
  clean install, and supported upgrade contain no native Pi path.
- Pin `@octocodeai/pi-extension` and its Pi-version matrix as the independent
  compatibility reference; changes follow its own Pi-host compatibility policy.
- After the approved observation and rollback window, delete the temporary
  native selector and every native Pi dependency, fallback, installer, updater,
  and release path. Retain the extension's tests, docs, and publication workflow.
- Preserve immutable redacted fixtures and signed comparison receipts.

### Continuous conformance gate

- Before native release closure, re-run complete native and Pi-extension suites independently.
- After selector and fallback removal, re-run the complete native-only suite and native zero-Pi scan.
- Re-run packed artifact, clean install, upgrade, session readability, and
  rollback checks from immutable artifacts.

### Exit gate

- Native agent/core have zero Pi-family source, manifest, resolution, built, and
  packed-artifact dependencies.
- No installed, published, selectable, documented-as-live, or supported Pi path remains in native artifacts or release wiring; the independent Pi extension remains supported.
- Native behavior, security, sessions, all modes, settings, OpenTUI, and every
  platform remain green.
- Signed closure records the final native dependency graph, native-only rollback
  disposition, removed native Pi inventory, extension boundary, and evidence inventory.

## Per-change workflow

For each package change:

1. Add or update a failing production-path test tied to traceability.
2. Implement the smallest coherent behavior behind the owning contract.
3. Compose it through the real package entry point in the same change or keep it
   explicitly `Implemented`, not `Composed`.
4. Run the changed workspace test, typecheck, and build.
5. Run affected real Pi/native conformance scenarios.
6. Run root lint/typecheck and broader tests in proportion to boundary risk.
7. Verify through the real CLI, RPC, MCP, settings/browser, or PTY path.
8. Attach exact commands, exits, counts, fixtures/hashes, first divergence,
   platform, dirty state, and reviewer to the phase receipt.

No checkbox, phase, RFC Step, or Migration Stage closes from compile success or
synthetic handlers alone.
