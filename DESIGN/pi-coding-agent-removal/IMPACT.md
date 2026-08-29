# Impact assessment: Remove `pi-coding-agent`

> Scope and decision: `RFC.md` §Goals and non-goals. Hooks/plugins: `HOOKS_AND_PLUGINS.md`. Detailed checks: `TEST_PLAN.md`. Quantitative comparison: `BEFORE_AFTER.md`.

## Impact summary

The migration changes the runtime ownership boundary across the launcher and harness. It must not silently change Octocode's model-facing tools, commands, security policy, session meaning, or supported modes. The highest-impact areas are session conversion, lifecycle ordering, compaction, cancellation, and transport compatibility.

## User impact

| User group | Expected effect | Risk | Protection |
|---|---|---|---|
| Interactive terminal users | Native rendering moves from Pi TUI components to OpenTUI with no required workflow change | Missing UI state, shortcut, accessibility, native artifact, performance, or terminal restoration behavior | OpenTUI test renderer, real PTY/platform matrix, semantic UI tests, measured gates, and canary rollback |
| Users configuring models/settings | One searchable HTML page replaces fragmented page/CLI/file workflows and shows effective provenance | Incorrect precedence, stale-tab overwrite, malformed catalog, destructive removal, or secret exposure | Registry completeness, revisions, semantic diff, atomic writes, backups, dependency checks, redaction, and security suite |
| Print/automation users | Stable output and exit-code contract | stdout/stderr or formatting drift breaks scripts | Golden command fixtures and exit-code matrix |
| RPC/JSON clients | Versioned Octocode contract with compatibility path | Payload or ordering changes break clients | Schema validation, captured protocol corpus, compatibility adapter |
| Existing-session users | Read-only Pi import into a separate native destination | History, branch, or compaction data loss | Hash/replay checks; original source stays unchanged |
| New-session users | Native persistence and runtime | New crash/recovery defects | Transaction, restart, and corruption suites |
| Tool users | Same approved public tool names and policies | Schema drift or different denial behavior | Registry snapshots and policy matrix |
| Command users | Same approved discoverable commands | Missing command or changed context permission | Inventory and command-flow tests |
| Multi-agent/Awareness users | Same plan, ownership, lock, and receipt meaning | Session identity mismatch or gate bypass | Cross-host continuity and negative mutation tests |

## Package and code impact

| Package/area | Change intensity | Main work | Primary risk |
|---|---:|---|---|
| `packages/octocode-agent-core/` | New/high | Own contracts, kernel, sessions, prompt, lifecycle/registries, and runtime adapters | Incorrect dependency direction or a second god package |
| `packages/octocode-agent` | High | Replace SDK composition, mode runners, Pi package resolution, fallback, sessions, and RPC types | Startup and transport regression |
| `packages/octocode-pi-extension` | High | Remain a supported Pi-host adapter while importing agent-core contracts and deleting duplicate domain ownership | Pi-version compatibility and translation drift |
| Shell/UI modules | High | Consume `AgentRuntime` and semantic `UiPort`; implement the native adapter with `@opentui/core` and remove native `pi-tui` after parity | UI behavior, packaging/runtime compatibility, accessibility, performance, and terminal restoration |
| Settings/model modules | High | Consolidate current HTML actions, launcher direct writes, effective model catalog, and legacy sources behind agent core contracts | Configuration drift, lost updates, model availability, migration, and credentials |
| Hook/plugin modules | High | Canonical events, Codex loader, trust, handlers, manifests, activation, typed contributions, and settings projection | Policy bypass, compatibility drift, arbitrary code, partial registration, or leak |
| Tool modules | Medium | Replace Pi-compatible types with host-neutral contracts through one funnel | Schema, policy, cancellation, renderer drift |
| Session/compaction modules | High | Introduce store/controller, importer, projections, and state machine | Data loss and retry loops |
| `packages/octocode-agent-testing` | Medium | Generalize Pi-named mock host into shared conformance harness | Oracle reproduces a mock instead of real behavior |
| Awareness package | Low-medium | Preserve identity and coordination integration; add cross-host tests | Ownership or receipt discontinuity |
| External Octocode engine packages | Low in first scope | Supply retained model/tool/provider adapters if needed | Accidental scope expansion |
| Manifests/build/release | Medium | Add runtime boundaries, remove dependency after gates, update packaging | Dependency cycle or missing bundled asset |

## API and interface impact

| Existing surface | Impact | Replacement rule |
|---|---|---|
| `PiInstance` | Removed from product modules | Split into required registries, lifecycle, transcript, process, model, and session capabilities |
| `PiContext` | Removed from product modules | Split immutable execution state from mutation services |
| `ToolDefinition` inheritance from Pi | Removed | Use host-neutral schema/execution contract plus policy/presentation metadata |
| Pi SDK module shape | Removed | One typed Octocode composition root |
| Pi RPC types | Removed | Generate or validate local versioned wire contracts |
| Pi `SessionManager` | Removed | `SessionIdentityReader`, `SessionController`, and `SessionStore` |
| Pi UI methods | Temporary oracle boundary, then removed | Frozen Pi oracle maps to Pi host UI during comparison; native agent maps semantic UI commands to OpenTUI; RPC/headless remain toolkit-free |
| Pi settings/model files | Compatibility adapters and declared sources | Unified settings/model contracts expose stored/effective values, provenance, safe mutation, and import behavior |
| Codex hook sources and plugin hook declarations | New supported compatibility input | Parse/validate declared format, preserve provenance, exact-hash review, publish compatibility version/gaps |
| Extension registrations | Generalized outside Pi adapter | Permission-scoped typed contributions through transactional canonical registries |
| Pi session JSONL | Import-only compatibility input | New writes target the selected native store |

Every replacement production interface in this table belongs under `packages/octocode-agent-core/`. The launcher and UI consume the interfaces; they do not redefine them.

The Pi extension is a temporary adapter exception: during comparison it owns Pi-only input/output types and translation code while importing canonical domain contracts from agent core. The final retirement change removes the extension package, supported-host matrix, selector, publication path, and live product documentation together.

This RFC does not promise source compatibility for internal Pi-named interfaces. It preserves observable product contracts and supplies temporary adapters where migration requires them.

## Data impact

| Concern | Severity | Required control |
|---|---:|---|
| Session history loss | Critical | Read-only source, separate destination, checksums, replay comparison, backup path |
| Branch ancestry change | High | Graph and leaf equality checks across fork/tree corpus |
| Custom entry enters model context | High | Explicit visibility classification and prompt-context assertions |
| Compaction state loss | Critical | Pre/post durable-state invariants and retry fault injection |
| Partial native write | High | Atomic append/transaction and restart recovery tests |
| Schema evolution | High | Version field, migrator chain, unknown-version rejection |
| Private content in fixtures | High | Synthetic/redacted corpus and secret scan |
| Dual-host writes to one session | Critical | Per-session host identity and no shared writable store during canary |

## Security impact

| Threat | Potential migration failure | Required defense | Test owner |
|---|---|---|---|
| Tool-policy bypass | A transport calls execution without lifecycle gates | One pre-execution policy chain in the kernel | Security/runtime |
| Trust bypass | New context defaults an unknown workspace to trusted | Fail-closed trust snapshot and negative modes | Security |
| Approval bypass | UI/headless path skips approval | Policy independent of renderer; explicit noninteractive behavior | Security/UI |
| Peer-lock bypass | New file/process path avoids Awareness gate | Capability-aware mutation classification | Awareness/tools |
| Secret exposure | New events persist provider/tool payloads | Field classification and redaction before logs/receipts | Runtime/observability |
| RPC confusion | Unknown version or malformed payload reaches runtime | Boundary schema validation and protocol version rejection | Transport |
| Session path traversal | Import/export accepts unsafe source/destination | Canonical path policy and adversarial fixtures | Sessions |
| Orphan process | Cancellation does not own spawned work | Structured execution scope and leak checks | Runtime/process |
| Untrusted hook/plugin code | Enablement or project discovery executes before review | Workspace trust, exact-definition hash, managed policy, and enablement separate from trust | Security/extensions |
| Hook output privilege escalation | Handler forges an allow/rewrite/event or registry mutation | Event-specific schema, deny-wins aggregation, kernel authorization | Security/runtime |
| Plugin partial activation/unload | Duplicate entries or leaked processes/resources | Transactional activation, leases, reverse cleanup, fail-fast conflicts | Runtime/extensions |

Any confirmed security bypass blocks rollout and triggers rollback. Aggregate success metrics cannot offset a security failure.

## Reliability and performance impact

| Dimension | Expected direction | Regression risk | Measurement |
|---|---|---|---|
| Startup | Fewer dynamic/fallback paths can reduce variance | New composition or store startup is slower | Cold/warm p50 and p95 |
| First event | Direct runtime events can reduce indirection | Adapter buffering delays output | Time from accepted input to first visible event |
| Streaming | Typed event pipeline can improve consistency | Backpressure or batching changes latency | Inter-delta distribution and order |
| Memory | Owning projections can remove duplicate state | Event log and projections duplicate Pi state during canary | Peak RSS with fixed corpus |
| Session writes | Transactions improve integrity | Sync or migration overhead | Append p50/p95 and throughput |
| Compaction | Explicit state improves diagnosis | Incorrect thresholds or retry loops | Completion latency and retry count |
| Cancellation | Structured ownership improves cleanup | Provider/process adapter ignores signal | Time to terminal state and leaked-handle count |

`KPI.md` requires measured thresholds from the canonical baseline. Do not approve a percentage without sample count and environment evidence.

## Operational impact

| Operation | Before | During migration | After |
|---|---|---|---|
| Host selection | SDK with subprocess fallback | Explicit `pi`, `shadow`, or `native` selector | Native only after compatibility closure |
| Diagnosis | Pi and extension logs/events | Correlated dual-host comparison receipts | Octocode runtime trace and typed errors |
| Rollback | Implicit fallback can hide cause | Explicit selector rollback | Release-artifact rollback |
| Session recovery | Pi reader/manager | Original Pi source plus isolated native destination | Native recovery and Pi import tooling |
| Release gate | Package tests and manual paths | Phase-specific conformance and canary gates | Native runtime release checklist |
| Support | Pi-specific failure vocabulary | Host and phase recorded in diagnostics | Octocode capability/error vocabulary |

## Maintenance impact

### Benefits

- Octocode controls runtime contract evolution and deprecation.
- Capability interfaces reduce optional-method checks and accidental privilege.
- One conformance suite supports terminal, RPC, and other hosts.
- Session and lifecycle failures become directly testable.
- Pi package updates stop changing the central runtime implicitly.

### Costs

- Octocode owns compatibility, session migrations, lifecycle semantics, and runtime incidents.
- Provider, terminal, and session adapters require ongoing conformance maintenance.
- The compatibility period temporarily increases code and test volume.
- Golden fixtures require disciplined normalization and review.

## Impact decision matrix

| Impact | Severity | Likelihood without controls | Detection | Rollout decision |
|---|---:|---:|---|---|
| Session loss/corruption | Critical | Medium | Import/replay/fault suites | Zero tolerance |
| Security-policy bypass | Critical | Medium | Negative matrix and receipts | Zero tolerance |
| Duplicate external effect | Critical | Low-medium | Effect IDs and shadow restrictions | Zero tolerance |
| Lifecycle semantic drift | High | High | Ordered golden traces | Approval required for any difference |
| RPC/automation break | High | Medium | Protocol corpus and script fixtures | Compatibility or explicit version migration required |
| UI regression | Medium-high | Medium | Semantic mode matrix and manual terminal check | Block on critical interactions |
| Performance regression | Medium | Medium | Controlled benchmarks | Threshold set from baseline |
| Increased maintenance load | Medium | High | Ownership and incident review | Accept only with named owners |

## Ownership required before rollout

| Area | Required owner/approver |
|---|---|
| Runtime contracts and lifecycle | Runtime maintainer |
| Session encoding and importer | Session/data maintainer |
| Trust, approval, and tool policy | Security approver |
| Interactive and RPC compatibility | UI/transport maintainer |
| Awareness identity and coordination | Awareness maintainer |
| Canary expansion and adapter deletion | Release owner |

Unset ownership blocks the dependent migration stage.
