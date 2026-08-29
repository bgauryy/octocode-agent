# Native CLI ↔ Pi Feature-Parity Audit

You are a senior software architect and coding agent performing an exhaustive, evidence-backed feature-parity audit between:

- **Baseline:** the supported Pi host running the real `@octocodeai/pi-extension` composition.
- **Candidate:** the real native `octocode-agent` launcher composed with `@octocodeai/agent-core` and its native adapters.

Your job is to determine which observable Pi behaviors the native agentic CLI preserves, intentionally replaces, improves, degrades, or has not yet implemented.

This is a parity audit, not a search for identical internals. The native implementation may use different architecture, storage, protocols, and UI technology. It passes only when the approved semantic contract and externally observable behavior are equivalent or an explicit design decision authorizes a difference.

Treat `@octocodeai/pi-extension` as a temporary executable parity oracle. The final target is one native editor with no live Pi package, dependency, adapter, launcher, installer, update, or release path. Do not delete the oracle early: first map every accepted capability to native evidence or an explicit approved retirement, pass native-only rollback, and preserve historical receipts unchanged.

## Audit rules

Read and follow the repository and applicable package `AGENTS.md` files before beginning.

Dogfood Octocode throughout the investigation:

- Use `npx octocode tools ...` and inspect live schemas with `npx octocode tools <name> --scheme`.
- Use `localViewStructure`, `localFindFiles`, `localSearchCode`, and `localGetFileContent` for discovery and evidence.
- Use `lspGetSemantics` for definitions, references, callers, callees, implementations, types, diagnostics, and reachability.
- Use AST/LSP evidence rather than relying only on text search.
- Use `npmSearch` to resolve external package metadata, versions, and source repositories.
- Use `ghSearchRepos`, `ghViewRepoStructure`, `ghSearchCode`, `ghGetFileContent`, `ghSearchPullRequests`, `ghSearchIssues`, and `ghSearchCommits` to research Pi, OpenTUI, provider SDKs, protocol libraries, and other external dependencies in their upstream repositories.
- Research official upstream source, documentation, releases, changelogs, compatibility policies, regressions, and design decisions whenever an external contract affects the parity verdict.
- Tie every consequential external conclusion to the dependency name, project-used version when authorized to inspect it, upstream tag/commit/release, and exact source file, PR, issue, or documentation location.
- Distinguish behavior proven for the project-used version from current upstream behavior. Never assume the latest upstream branch describes the installed or supported version.
- Treat search and dead-code results as candidates. Prove identity and production reachability through semantic references, composition roots, real runtime wiring, tests, or execution receipts.
- Do not use bare `find`, `grep`, `rg`, `cat`, or `ls` when an Octocode tool covers the operation.

Record the Octocode queries used for consequential local and external conclusions. If Octocode cannot access a required source, name the evidence gap and use another approved research route rather than guessing.

Respect repository access restrictions. Do not hand-edit generated output, `.octocode/` state, build artifacts, manifests, lockfiles, or configuration files without authorization.

Do not change production code during the audit. First produce the complete parity report. Implement fixes only when the invoking task explicitly authorizes implementation, and then follow TDD and repository verification rules.

## Sources of truth

Inspect the complete current `DESIGN/` tree before evaluating code. Do not rely on filenames remembered from an older revision; discover the live tree first.

Use the authority rules in `DESIGN/README.md`:

1. `DESIGN/pi-coding-agent-removal/RFC.md` owns product scope, goals, non-goals, accepted decisions, and compatibility promises.
2. `READINESS_AND_FEATURE_MATRIX.md` owns stable feature IDs and the complete target inventory.
3. `SCHEMAS_AND_TYPES.md` owns canonical contracts and Pi mappings.
4. `TEST_PLAN.md` and `KPI.md` own pass/fail rules and behavioral equivalence.
5. `STATUS.md` owns current progress, not requirements.
6. Root `DESIGN/*.md` documents refine implementation and verification but may not silently override the source RFC.

If documents disagree, mark the affected parity row `HOLD`, quote the conflicting requirements, identify the owning document, and request a design/RFC decision. Do not choose whichever requirement makes parity easier.

Documentation may be stale. Record missing files, broken links, obsolete paths, contradictory status claims, and requirements that no longer match code, but do not silently substitute your own design.

## Definition of parity

Classify every feature using exactly one implementation maturity state:

- **Declared:** represented only in documentation, a type, schema, or interface.
- **Implemented:** concrete behavior exists in code.
- **Composed:** the real production host reaches the behavior.
- **Verified:** production-path tests and real execution evidence pass.
- **Cutover-ready:** real Pi/native conformance, security, packaging, platform, and rollback gates pass.

Also assign one parity result:

- **MATCH:** normalized observable behavior satisfies the approved shared contract.
- **APPROVED DIFFERENCE:** behavior differs, and an authoritative design decision explicitly permits it.
- **NATIVE SUPERSET:** native adds behavior without breaking the shared contract or Pi-extension compatibility.
- **PARTIAL:** some branches or modes match, but required coverage is incomplete.
- **MISMATCH:** observable behavior violates the shared contract.
- **MISSING:** required behavior is absent from the native production composition.
- **UNPROVEN:** code or tests suggest parity, but real-host evidence is insufficient.
- **NOT APPLICABLE:** an authoritative contract explains why the surface does not apply. Lack of implementation is not a valid reason.
- **HOLD:** normative sources conflict or a required product decision is unresolved.

Parity must be proven at the production composition boundary. Shared types, copied schemas, unit tests around a fake handler, manually emitted success events, or structural similarity do not establish parity.

## Phase 1 — Build the complete parity inventory

Start with every stable feature ID in `READINESS_AND_FEATURE_MATRIX.md`. Do not sample. Create one ledger row for every current ID in these groups:

- `R-*`: runtime and architecture
- `T-*`: tools, commands, resources, transports, SDK/embed, shadow mode, and host selection
- `S-*`: sessions, persistence, context, migration, recovery, and compaction
- `H-*`: canonical events, Pi listener mapping, Codex hooks, trust, decisions, execution, and observability
- `P-*`: plugin discovery, grants, lifecycle, contributions, conflicts, updates, and unload
- `U-*`: OpenTUI semantics, interaction, accessibility, restoration, settings, models, and protected local server
- `A-*`: workers, typed spawn packets, ledgers, messaging, wait/abort/kill, durable mailboxes/handoffs, Awareness-backed scheduling, and worktrees
- `Q-*`: Pi support, version matrix, conformance, absence proof, fault/security/performance/platform matrices, receipts, and rollback

For each ID capture:

| Field | Required evidence |
|---|---|
| Feature ID and requirement | Exact current design source |
| Pi baseline owner | Real Pi-extension symbol, composition root, or host behavior |
| Native owner | Real native/core symbol and composition root |
| Baseline invocation | How the behavior is triggered on Pi |
| Candidate invocation | How the behavior is triggered natively |
| Observable contract | Events, state, output, effect, protocol, or UI semantics compared |
| Pi tests | Existing real-path or adapter tests |
| Native tests | Existing production-path tests |
| Shared conformance scenario | Corpus/scenario identifier, or explicit missing case |
| Runtime evidence | Commands, trace hashes, PTY/RPC output, records, or receipts |
| External/upstream evidence | Package version plus upstream source, release, PR, issue, or official contract used to interpret parity |
| Maturity | Declared through Cutover-ready |
| Parity result | MATCH through HOLD |
| First divergence | Exact event/field/state/effect where behavior differs |
| Severity and impact | User, security, data, extension, or release consequence |
| Required action | Test, implementation, design decision, documentation fix, or none |

Do not collapse multiple feature IDs into a vague subsystem conclusion.

## Phase 2 — Map both real hosts

Build two evidence-backed runtime maps.

### Pi baseline

Trace the actual supported path through:

```text
Pi host
  -> @octocodeai/pi-extension activation
  -> agent-core or Pi compatibility mappings
  -> prompt/tools/commands/hooks/settings/Awareness composition
  -> Pi model/session/UI/runtime APIs
  -> user-visible output, effects, persistence, and shutdown
```

Identify every declared supported Pi version and the compatibility behavior for unsupported versions.

### Native candidate

Trace the actual production path through:

```text
octocode-agent executable
  -> argument/config parsing
  -> native composition root
  -> @octocodeai/agent-core kernel and canonical services
  -> native model/tool/session/settings/transport/OpenTUI adapters
  -> user-visible output, effects, persistence, and shutdown
```

Prove that a capability is reachable from the packaged launcher. A class instantiated only in tests is not composed.

## Phase 3 — Capture a canonical Pi baseline

Use the actual Pi extension/harness composition as the baseline adapter. Do not use a synthetic handler that manufactures expected events.

Capture:

- exact repository commit and dirty-tree state;
- package and supported Pi versions;
- resolved dependency versions and upstream source/tag/commit evidence for every external contract used by the comparison;
- runtime, OS, architecture, terminal, and relevant feature flags;
- normalized prompt snapshot and tool/command/resource inventories;
- canonical event trace and final state;
- effect ledger and policy/approval decisions;
- session artifacts and projected model-visible context;
- stdout, stderr, exit code, JSON/JSONL/RPC frames, or PTY transcript as applicable;
- redaction counts and evidence that secrets are absent.

Historical receipts are evidence, not proof of the current tree. Re-run or mark stale when inputs, contracts, adapters, fixtures, or supported versions changed.

## Phase 4 — Run the mandatory shared scenarios

Run the same semantic scenario through both real adapters. Cover at least:

1. Start a session, register tools/commands/hooks, and stop cleanly.
2. Submit one deterministic prompt and capture the complete turn.
3. Stream text, thinking, tool-call arguments, tool updates, and results.
4. Block a tool independently through plan policy, workspace trust, approval, and peer lock.
5. Fail a tool before execution, during execution, and during result persistence.
6. Cancel before submit, during model streaming, during tool work, during child-process work, and during compaction.
7. Send steer and follow-up input while streaming.
8. Create, name, resume, switch, fork, navigate, rewind, export, and stop a session.
9. Compact manually, at threshold, on overflow, on retry, and on failed retry.
10. Exercise every canonical UI interaction using interactive and headless adapters.
11. Run print, JSON, and RPC command/event corpora.
12. Restart after each persistence fault and prove one deterministic projection.
13. Load reviewed Codex hooks, dispatch every mapped lifecycle event, and compare decision, context, rewrite, timeout, failure, and cancellation receipts.
14. Discover, activate, use, disable, unload, update, and resume with a synthetic plugin while proving transactional contributions and zero owned resources.

For the Pi adapter, execute the required scenarios against every declared supported Pi version. Add adapter-specific cases for activation, typed unsupported-version failure, event mapping, narrowed privileges, UI fallback, session identity, and renderer-only behavior.

## Phase 5 — Compare every behavioral surface

### Runtime lifecycle and agent loop

Compare startup, ready, turn, model, tool, cancellation, terminal, and shutdown ordering. Verify one owner, legal state transitions, bounded model/tool/retry/time limits, exactly one terminal result, and no events after `runtime.stopped`.

### Prompt and model behavior

Compare ordered prompt segments, provenance, system/context fragments, resumed model-visible history, tool definitions, thinking controls, provider normalization, retry attribution, usage, stop reasons, malformed stream handling, and secret redaction.

### Tools and policy

Compare tool names, descriptions, schemas, defaults, preparation, validation, effect classification, updates, results, errors, cancellation, and persistence order. Verify the same ordered pre-effect security boundary covers trust, managed policy, plan mode, peer locks, hooks, approval, and the final input/effect digest.

### Commands and resources

Compare command inventory, descriptions, completion, aliases, context privileges, headless availability, skills, prompts, assets, MCP servers, provenance, containment, and unsupported behavior. An inventory mismatch requires either an approved removal/addition or a parity finding.

### Sessions and compaction

Compare identity, naming, host selection, create/resume/switch/fork/tree/rewind/export, model-visible projection, display-only entries, optimistic revisions, concurrent writes, backup recovery, corruption handling, streaming durability, no-session behavior, and compaction terminal states.

For Pi import, prove the source remains byte-stable and conversion commits a separate native destination transactionally.

### Events, hooks, and plugins

Map every production-used Pi composed/direct listener to a canonical event. Compare ordering, decisions, context, rewrites, trust hashes, timeouts, cancellation, output safety, and diagnostics. Verify plugin grants, transactional activation, conflict behavior, contribution ownership, leases, update/resume provenance, reverse unload, and zero leaked resources.

### Terminal and semantic UI

Compare semantic behavior, not toolkit types or exact pixels. Cover input, editor, confirm/select, notifications, status, widgets, title, focus, mouse fallback, resize, Unicode width, narrow terminals, accessibility, streamed presentation, crash paths, and terminal restoration.

Native OpenTUI types must remain adapter-private. Print, JSON, and RPC modes must not initialize OpenTUI or emit terminal control bytes.

### Settings and models

Compare the complete settings registry, defaults, scopes, precedence, provenance, stored/effective values, revisions, conflicts, rollback, redaction, models/provider catalog, source management, Hooks/Plugins panels, protected server controls, deep links, and host-specific fallbacks. Every supported setting must be visible and classified; no raw secret-bearing storage object may reach output.

### Transports and output

For interactive, print, JSON, and RPC, compare startup/stop, prompt/result behavior, commands, sessions, cancellation, malformed input, correlations, concurrency, stdout/stderr purity, exit codes, and cleanup.

Use this minimum mode matrix:

| Behavior | Interactive | Print | JSON | RPC |
|---|---|---|---|---|
| Startup and clean stop | Required | Required | Required | Required |
| Prompt and streamed output | Required | Required | Required | Required |
| Steer/follow-up | Required | Contractual N/A | When exposed | Required |
| Cancellation | Required | Signal/timeout | Required | Required |
| Tool updates/results | Required | Final output | Required | Required |
| Commands/discovery | Required | Approved subset | Approved subset | Required |
| Session operations | Required | Approved subset | When exposed | Required |
| Compaction/retry | Required | When invoked | Required | Required |
| UI interaction | Required | Headless fallback | Semantic fallback | Protocol request/response |
| OpenTUI initialization | Required | Forbidden | Forbidden | Forbidden |
| Malformed input | User-visible typed error | Nonzero exit | Typed record | Correlated response |
| Restoration/output purity | Terminal restored | stdout/stderr contract | JSON-only stdout | JSONL-only stdout |

## Phase 6 — Normalized trace comparison

Normalize only nondeterministic representation:

- timestamps to relative sequence markers;
- temporary roots to stable logical roots;
- generated IDs through a bijective mapping that preserves equality and ancestry;
- explicitly approved provider noise.

Never normalize away:

- event order;
- session ancestry or selected leaf;
- request, call, effect, or result correlation;
- containment-relevant paths;
- policy and approval decisions;
- visibility/model-context classification;
- tool or command names;
- terminal reasons and error categories;
- token/usage semantics;
- exit codes;
- duplicate or unregistered effects.

Report the first semantic divergence plus each complete normalized trace hash. A broad “mostly equivalent” statement is not acceptable.

## Phase 7 — External-effect safety

Use a shared effect ledger for cross-host comparisons:

- **Pure mode:** neither host performs external effects.
- **Shadow mode:** the candidate proposes effects, but the ledger blocks execution.
- **Live mode:** exactly one designated host may execute each effect.

Each effect record must include stable identity, semantic operation, target, input digest, owner, mode, decision history, and terminal state. Reject duplicated or unregistered effects across hosts, retries, reconnects, resumes, hooks, and plugins.

Any security bypass, duplicate effect, unregistered effect, secret leak, corrupted session, or surviving owned process is a critical parity failure regardless of other matches.

## Phase 8 — Tests and evidence quality

Audit existing evidence before trusting it:

- Does the test invoke the real Pi adapter and real native composition?
- Does it use the same scenario input and oracle?
- Does it compare canonical normalized output rather than implementation details?
- Can a no-op or fake runtime pass?
- Are failures, cancellation races, persistence faults, and cleanup checked?
- Are supported platforms and Pi versions covered?
- Are claims about Pi, OpenTUI, provider SDKs, protocols, or other dependencies verified against the project-used version rather than inferred from current upstream documentation?
- Are fixture changes reviewed as public-contract changes?
- Are raw receipts retained with hashes and named commits?

Identify missing shared scenarios, fake-host false positives, stale snapshots, weakened assertions, skipped cases, and tests that prove only declaration or implementation rather than production composition.

## Required deliverables

Return the audit in this order:

1. **Executive verdict** — whether parity is cutover-ready, with the highest-risk blockers.
2. **Authority and scope notes** — documents read, conflicts, stale references, and unresolved decisions.
3. **External dependency evidence map** — package/version, upstream repository and revision, relevant APIs/contracts, compatibility findings, and unresolved evidence gaps.
4. **Pi baseline map** — actual composition, versions, inventories, and invocation paths.
5. **Native candidate map** — actual composition and production reachability.
6. **Complete feature-ID ledger** — one row per current `R-*`, `T-*`, `S-*`, `H-*`, `P-*`, `U-*`, and `Q-*` requirement.
7. **Behavioral equivalence matrix** — runtime, input, turns, tools, commands, models, messages, sessions, compaction, UI, settings, hooks, plugins, transports, cancellation, and security.
8. **Mode matrix** — interactive, print, JSON, and RPC results.
9. **Temporary Pi-oracle matrix** — frozen artifact/version identity, activation, semantic baseline coverage, and the evidence-retention plan after deletion.
10. **First-divergence reports** — exact trace location and impact for every mismatch.
11. **Test/evidence gaps** — what remains unproven and why existing evidence is insufficient.
12. **Prioritized remediation plan** — smallest dependency-safe work packages and tests.
13. **Cutover recommendation** — `GO`, `HOLD`, or `NO-GO`, tied to explicit design gates.

For every mismatch provide:

```text
Feature ID:
Severity:
Parity result:
Pi location and symbol:
Native location and symbol:
Baseline invocation:
Candidate invocation:
Expected shared contract:
Observed Pi behavior:
Observed native behavior:
First divergence:
Evidence and trace hashes:
User/security/data/release impact:
Required test:
Smallest recommended fix:
Risk:
Confidence:
```

Use exact paths, symbols, and line anchors. Clearly distinguish proven mismatch, approved difference, likely risk, missing evidence, and documentation drift.

## Implementation and verification policy

If implementation is explicitly authorized after the audit:

1. Select the highest-severity proven mismatch whose design is resolved.
2. Add or update the shared conformance scenario first and confirm the native side fails for the expected semantic reason.
3. Implement the smallest correction without copying Pi internals into agent core.
4. Run focused unit, adapter, and shared conformance tests.
5. Rebuild every changed package.
6. Exercise the real Pi and native host paths again.
7. Update the feature ledger and design status only with new evidence.
8. Run applicable workspace tests, lint, typecheck, builds, CLI/RPC/PTY smokes, platform checks, and packaging checks.

Do not remove Pi dependencies, fallback paths, or the extension package merely to make a static absence check pass. Complete Pi retirement is the final consequence of verified parity, security, native-only rollback, packaging, migration, upgrade, and observation gates.

## Final questions

Answer each directly:

- Does every current feature ID have production-path evidence for both hosts?
- Which Pi behaviors are missing or only partially composed in the native CLI?
- Which differences are explicitly approved rather than accidental?
- Do both hosts produce the same normalized lifecycle, policy, tool, session, and terminal semantics?
- Are interactive, print, JSON, and RPC contracts all covered?
- Does steering, follow-up, cancellation, retry, and shutdown behave correctly under concurrency?
- Are session ancestry, resumed context, migration, recovery, and compaction equivalent and durable?
- Are hooks, plugins, settings, models, tools, commands, and resources complete and safe?
- Does the frozen Pi oracle cover every accepted baseline behavior, and can its live package be deleted without losing required evidence?
- Can either host bypass policy or produce duplicate/unregistered effects?
- Is the native editor cutover-ready, can rollback succeed without Pi, and what exact evidence still blocks the final Pi-deletion `GO`?
