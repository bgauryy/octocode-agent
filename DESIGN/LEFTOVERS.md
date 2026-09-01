# Octocode Agent leftovers

Status: active completion ledger; reconciled 2026-09-01; release remains `HOLD`.

This file is the only live repository-level ledger for work remaining on the
native Octocode Agent. Package architecture documents own implemented behavior
and boundaries. Production code, executable contracts, and tests outrank this
ledger when they disagree.

The dated files under
[`pi-coding-agent-removal/evidence/`](pi-coding-agent-removal/evidence/) are
immutable observations. They preserve history but never define current status.

## Product end state

Octocode ships a Pi-free native agent and an independently installed, supported
Pi extension. Native packages, launchers, installers, update paths, and rollback
artifacts must not import or execute Pi. The Pi extension may retain its pinned
Pi dependencies inside its own package boundary.

The dirty-tree candidate is substantial and locally verified, but it is not a
release candidate. Do not publish, start a canary, declare migration complete,
or remove rollback paths until every closure gate in this file passes.

## Settled ownership

| Surface | Canonical owner |
|---|---|
| Runtime lifecycle, policy, effects, sessions, compaction, context, workers, and host-neutral contracts | [Agent core architecture](../packages/octocode-agent-core/ARCHITECTURE.md) |
| SQLite transactions, revisions, effects, leases, fencing, communication, automation durability, and contained filesystem primitives | [Rust services architecture](../packages/octocode-agent-core-rust/ARCHITECTURE.md) |
| Native providers, tools, MCP, approvals, scheduling, worker processes, transports, presentation, settings, and OpenTUI | [Native architecture](../packages/octocode-agent/ARCHITECTURE.md) |
| Supported Pi adaptation and Pi-only compatibility behavior | [Pi extension architecture](../packages/octocode-pi-extension/ARCHITECTURE.md) |
| Production conformance scenarios and normalized evidence | [Agent testing architecture](../packages/octocode-agent-testing/ARCHITECTURE.md) |
| Shared paths, protocols, permissions, discovery shapes, and prompt fragments | [Shared architecture](../packages/octocode-shared/ARCHITECTURE.md) |
| Plans, work, locks, messages, verification, memory, and coordination | [Awareness architecture](../packages/octocode-awareness/ARCHITECTURE.md) |

These boundaries are settled:

- Agent core is host-neutral and never imports native, Pi, OpenTUI, provider, or
  filesystem implementations.
- Rust owns atomic durability and contained filesystem primitives. TypeScript
  owns semantic policy, validation, scheduling, tool behavior, and process
  supervision.
- The native model sees a compact Octocode research facade plus explicit native
  base tools. Research implementation remains in the external Octocode packages.
- Only a root agent creates workers. Children are depth-one leaves and never
  receive worker-creation capability.
- `settings.html` is the native human-facing configuration surface.
- ACP is the editor interoperability protocol. Native JSONL RPC remains the
  automation protocol.
- Awareness owns coordination state, not repository or runtime truth.

## Verified candidate capabilities

Do not reimplement these capabilities. Extend their owning contracts or close
the remaining evidence gates instead.

- The native runtime composes OpenAI Chat, OpenAI Responses, Anthropic Messages,
  and custom provider adapters behind one bounded loop.
- Permission modes, trust, plans, locks, approvals, input-sensitive effects,
  durable admission receipts, cancellation, and uncertain-effect settlement run
  through the core policy boundary.
- Native `file`, `bash`, `web`, and `runFfmpeg` tools publish separate capability,
  approval, cancellation, and concurrency contracts. File mutation and FFmpeg
  path authorization use the supervised Rust filesystem service.
- Typed media and artifact results preserve bounded text, image, and workspace
  artifact descriptors through provider translation, durable sessions, resume,
  and fork. Native media authoring uses the supervised filesystem and FFmpeg
  process boundaries.
- Native browser diagnostics expose bounded target, DOM snapshot, screenshot,
  console, and network operations for explicitly configured loopback Chrome
  DevTools Protocol endpoints. The tool does not expose arbitrary evaluation,
  cookies, storage, navigation, or input control.
- Rust-backed edit checkpoints use a content-addressed, two-phase journal.
  Native file mutations create checkpoints, and rewind remains a distinct,
  digest-fenced effect with crash and drift recovery.
- Artifact preview serves manifest-selected workspace files on an unguessable
  loopback route with exact host, method, containment, digest, and response-header
  checks. The tool receipt does not disclose the capability URL.
- MCP discovery, connection reuse, ordered parallel calls, elicitation,
  cancellation, provenance, and official Tasks requests are production-composed.
- Durable sessions support create, resume, switch, fork, name, export, lineage
  navigation, manual compaction, threshold compaction, and restart recovery.
- Context artifacts preserve stable prompt prefixes and project plans, Skills,
  memory leads, tool summaries, and committed compaction data as inspectable data.
- Root-only workers, message leases, addressed communication, progress events,
  restart recovery, and RPC/ACP projection are composed.
- The worker inbox projects a bounded public view and supports generation-fenced
  inspect, message, follow-up, steer, abort, and separately approved force-kill
  actions through slash commands and OpenTUI.
- Plan editing uses revision-preconditioned, stable-ID intents for editing,
  reordering, dependencies, reopening, approval, rejection, change requests, and
  review. Dependency and completion changes invalidate affected verification
  receipts.
- Streamable HTTP MCP supports origin-bound OAuth discovery, PKCE, loopback
  callback validation, operating-system credential storage, redacted status, and
  explicit revocation. Credentialed external-server proof remains a release gate.
- Filesystem hooks, Codex-compatible command and MCP handlers, bounded async hook
  ownership, reviewed plugins, transactional activation, rollback, leases, and
  unload are composed.
- Native settings mutations are revisioned, atomic, redacted, and shared across
  runtime, CLI, and browser actions.
- The renderer-neutral presentation port and semantic OpenTUI widgets cover
  input, Ask, plans, workers, tools, status, notifications, and restoration.
- The production conformance matrix reports 12 cross-host matches, two
  native-specific covered scenarios, no divergence, and no unsupported scenario
  in the current working tree.

## Remaining work

Complete these groups in order. A later group cannot compensate for an earlier
gate that remains open.

### 1. Freeze the candidate

- Select one clean commit and record the exact working-tree policy.
- Freeze environment versions, fixture hashes, held-out scenario hashes, and
  privacy rules.
- Reproduce the full build, package, Rust, native, Pi, and production-conformance
  gates from that commit.
- Record an independently reviewed canonical-before receipt without rewriting
  older evidence.

### 2. Close semantic and policy decisions

- Define which event payload fields are stable public protocol and which remain
  adapter-private.
- Formally accept the Octocode-owned runtime and provider architecture; remove
  obsolete temporary ownership language.
- Pin the supported ACP SDK/schema and MCP Tasks extension revisions with exact
  conformance fixtures.
- Select a pinned external Octocode tool boundary. It must provide authoritative
  effects, lock targets, output schemas, executable identity, and version
  negotiation so native code can remove name-based inference.
- Finish effect-receipt digest, expiry, policy-revision, crash, concurrency,
  retention, and cross-host semantics.
- Finish the single settings-registry lifecycle and remove remaining direct
  settings writers.

### 3. Complete durability and context proof

- Prove migration rollback, changing-source behavior, malformed input handling,
  replay equality, stale writers, and byte-preserving projection.
- Complete corruption, interrupted-write, partial-assistant, temporary-state,
  pagination, and cross-platform fault matrices.
- Prove overflow compaction, retained-reference validity, cancellation, restart,
  retry bounds, and cache-stable rehydration against real provider requests.

### 4. Complete runtime and integration proof

- Run credentialed provider, retry, cancellation, malformed-stream, cache-token,
  latency, memory, and failure matrices.
- Exercise Streamable HTTP and OAuth MCP servers, Tasks isolation, restart,
  cancellation, elicitation, and catalog-change behavior through production
  composition.
- Complete Skill discovery, activation, refresh, policy, and compaction behavior
  across native and Pi hosts.
- Run the zero-bypass matrix across model calls, tools, hooks, plugins,
  automations, MCP, RPC, ACP, and projected worker commands.

### 5. Complete orchestration proof

- Complete worktree create, refresh, retain, merge, discard, and crash recovery.
- Run multi-process mailbox, handoff, dead-pipe, backpressure, cancellation,
  orphan, restart, and process-cleanup matrices on supported platforms.
- Prove that every worker and automation action remains bound to session, trust,
  approval, capability, effect, and ownership state.

### 6. Complete extension and configuration proof

- Pin the Codex hook compatibility fixture and run the complete matcher, output,
  timeout, cancellation, failure, and cross-host matrix.
- Approve the formal plugin capability policy for filesystem, process, network,
  MCP, model, secret, settings, and UI contributions.
- Complete plugin update, restart, changed-hash, spoofing, partial-activation,
  rollback, lease, residue, and secret-leak tests.
- Complete Models, Hooks, Plugins, Skills, Connections, diagnostics, reset,
  import, export, recovery, and native/Pi settings conformance.
- Run browser CSP, origin, action-token, no-store, containment, accessibility,
  responsive-layout, concurrent-write, and rollback tests from a packed install.

### 7. Complete terminal and platform proof

- Approve the supported OpenTUI runtime and packaging route, including the Node
  experimental-FFI policy.
- Verify packaged native assets and startup, shutdown, signals, and exact terminal
  restoration on every supported operating system and architecture.
- Complete sustained streaming, Unicode, resize, paste, mouse, masked input,
  alternate output, screen-reader, keyboard-only, cancellation, and fault tests.
- Measure startup, first frame, frame duration, memory, and shutdown against the
  accepted release thresholds.

### 8. Canary, rollback, and close native Pi removal

- Set quantitative shadow and canary thresholds, cohort rules, owners, observation
  duration, abort conditions, and rollback criteria.
- Produce signed before-and-after reliability, security, effects, performance,
  session, terminal, and migration comparisons.
- Rehearse rollback to the prior native artifact without losing durable sessions.
- Pass clean installation, supported upgrade, dependency-tree, package-content,
  and release-artifact checks.
- Prove that native artifacts and release wiring contain no Pi dependency or
  executable Pi path.
- Pin and pass the independent Pi extension compatibility and publication matrix.
- Complete the observation window before removing selectors, fallbacks, or
  rollback artifacts.

## Closure gates

| Gate | Current state | Required closure evidence |
|---|---|---|
| Local implementation | Verified candidate | Reproduce from the clean named commit |
| Production conformance | Green in the working tree | Clean, frozen, independently attributed run |
| Session and context integrity | Partial | Import, migration, corruption, overflow, crash, and replay corpus |
| Security and effect safety | Partial | Complete zero-bypass, receipt, hook, plugin, and secret matrix |
| Providers and MCP | Partial | Credentialed providers, HTTP/OAuth MCP, faults, and performance |
| Workers and orchestration | Partial | DAG, worktree, multi-process, handoff, and platform cleanup corpus |
| Settings and terminal | Partial | Packed browser, accessibility, PTY, and supported-platform matrix |
| Native Pi isolation | Partial | Clean dependency, installation, upgrade, artifact, and rollback receipts |
| Canary and observation | Not started | Thresholds, signed comparison, observation window, and approval |

The release remains `HOLD` while any row is partial or not started. Package-local
tests, source import cleanliness, or a dirty-tree conformance pass cannot substitute
for a closure receipt.

## Updating this ledger

- Add implementation detail to the owning package architecture or operational
  guide, not this file.
- Update this file only when a remaining gate changes state, an ownership decision
  changes, or a new release blocker appears.
- Link exact dated observations under
  [`pi-coding-agent-removal/evidence/`](pi-coding-agent-removal/evidence/).
- Never edit historical evidence to match later behavior.
- Remove completed bullets instead of accumulating a second implementation history.
- Do not add exact test totals, source sizes, or generated inventories. Link the
  executable owner instead.
