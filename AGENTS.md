# AGENTS.md — Octocode Agent monorepo

This repository ships the host-neutral agent kernel, native CLI, packaged Rust
services, supported Pi adapter, conformance tooling, shared contracts, and
Awareness coordination. The closest `AGENTS.md` wins. Work under
`packages/octocode-awareness` also follows its
[package guide](packages/octocode-awareness/AGENTS.md).

Read the owning package's `ARCHITECTURE.md` before changing a boundary.

## Package ownership

| Change | Start in | Also verify |
|---|---|---|
| Runtime, lifecycle, policy, effects, sessions, compaction, workers, or host-neutral UI/RPC contracts | [`octocode-agent-core`](packages/octocode-agent-core) | Native and Pi conformance |
| SQLite transactions, CAS, leases, fencing, indexes, durable queues, automations, or contained filesystem primitives | [`octocode-agent-core-rust`](packages/octocode-agent-core-rust) | Native Rust ports and real subprocess flows |
| Providers, native tools, MCP, approvals, scheduler, worker processes, transports, or OpenTUI | [`octocode-agent`](packages/octocode-agent) | Built CLI and real-host flow |
| Supported Pi hooks, prompt, tools, Skills, UI, or host adaptation | [`octocode-pi-extension`](packages/octocode-pi-extension) | Native/Pi scenarios |
| Trace normalization, effect comparison, parity scenarios, or host fixtures | [`octocode-agent-testing`](packages/octocode-agent-testing) | Production packages never import it |
| Cross-host paths, protocols, permissions, discovery, entities, or prompt fragments | [`octocode-shared`](packages/octocode-shared) | Every consuming host |
| Plans, work, locks, messages, verification, memory, reflection, or coordination hooks | [`octocode-awareness`](packages/octocode-awareness) | Nested guide and real CLI |

External packages remain separate. `@octocodeai/config` owns environment and
Octocode-home loading. `octocode-tools-core`, `octocode-engine`, and
`octocode-core` own research execution, search/LSP machinery, schemas,
descriptions, and prompt text. `@octocodeai/mcp` and `octocode-mcp-vscode` own
their interfaces.

## Boundary rules

- Dependencies point inward: host composition -> adapters -> core contracts.
  Agent core never imports a host package.
- Only `packages/octocode-pi-extension` may declare or import
  `@earendil-works/pi-*`. Native, core, Rust, shared, Awareness, and testing
  code never import Pi directly.
- Put semantic invariants in agent core. Put operating-system, SDK, protocol,
  process, and UI behavior behind injected ports in the owning host.
- Rust owns atomic durability, integrity, and contained filesystem primitives.
  TypeScript owns orchestration, policy, validation, tool semantics, providers,
  schedules, and child-process supervision.
- Native production code must not import Pi or `agent-testing`. Production
  packages must not import test-only conformance code.
- Import the module or published subpath that owns a symbol. Do not use internal
  wildcard barrels as dependency shortcuts.
- Decode durable records and RPC envelopes with strict core parsers. Change
  `AgentEventPayloadMap` and its versioned RPC validator together.
- Keep OpenTUI values under
  `packages/octocode-agent/src/terminal/opentui`. Controllers and renderers use
  `packages/octocode-agent/src/presentation/contracts.ts`.
- Use `@octocodeai/config` and shared path helpers. Never duplicate
  `getOctocodeHome`, environment parsing, protected-key handling, or canonical
  path resolution.
- Generated `dist/`, `out/`, `target/`, SQLite, and `.octocode`
  projections are not source. Change their owners and rebuild.
- Refactor without compatibility shims unless the task explicitly requires
  backward compatibility.

## Runtime safety invariants

- Tool order is schema validation -> input-sensitive policy -> trust/approval ->
  effect admission -> bounded execution -> settlement -> events. Runtime
  operations, automations, model calls, and worker commands use this boundary.
- A crash-left `started` effect becomes `uncertain`; never replay it as if it
  did not run. Preserve model call order even when admitted work overlaps.
- `strict`, `default`, and trusted `allow-all` affect promptable approval
  only. No mode bypasses schema, trust, managed policy, plan/lock rules,
  capability ceilings, mandatory approval, or the effect ledger.
- The model sees one compact `octocode` research facade. `file`, `bash`,
  `web`, and `runFfmpeg` publish separate effects, trust, approval, limits,
  cancellation, and concurrency metadata.
- Native file changes and FFmpeg path authorization use the supervised Rust
  filesystem service. Production fails closed without it; the Node adapter is a
  test fixture. TypeScript owns file schemas/edit semantics and FFmpeg arguments,
  progress, limits, and process supervision.
- `MCPTool` owns negotiated discovery, calls, tasks, cancellation, elicitation,
  provenance, and connection reuse. Global and per-server concurrency both apply;
  connection recovery never replays a possibly committed call.
- Sessions, effects, revisions, communication leases, and automation state use
  the Rust actor. `--no-session` is in-memory. Compaction commits before live
  context changes; resume reconstructs only committed state.
- Context artifacts are typed data with provenance, trust, retention, digest,
  and cache class. Generated summaries and memory never become hidden
  instructions.
- Only a root agent creates workers. Children are depth one, never receive the
  worker capability, and become sealed at `wait`. Rust leases messages before
  delivery and never blindly replays stranded leases.
- TypeScript expands schedules and submits semantic actions through policy. Rust
  atomically materializes, fences, leases, and settles runs; it never executes
  arbitrary automation payloads.
- The independent Pi extension remains supported but is not a native dependency.
  Compare hosts through production adapters and normalized effect traces.
- Awareness SQLite is coordination state, not repository truth. Ordinary file
  presence is advisory; use exclusive locks only for unsafe non-mergeable work.

## Research and dogfooding

Use Octocode to build Octocode:

| Need | Use | Avoid |
|---|---|---|
| Local structure, content, search, graph analysis, or LSP | Octocode MCP or `npx octocode tools ...` | Bare `find`, `grep`, `rg`, `cat`, or `ls` |
| GitHub repositories, code, issues, PRs, or commits | Octocode GitHub tools | Ad hoc API calls |
| npm packages | `npmSearch` | Registry curls |
| Research or change investigation | `octocode-research` plus live schemas | Invented search loops |
| Shared work or cross-run context | Awareness | Silent overlapping edits |

Run `npx octocode tools --json` for the live catalog and
`npx octocode tools <name> --scheme` before assuming a name, count, or schema.
Search and graph results are candidates. Prove symbol identity, callers, and
reachability with `lspGetSemantics` before deleting code. Follow pagination,
range, minification, and truncation hints until the required evidence is visible.

### Research catalog (13)

The supported Pi-facing catalog is `ghSearch`, `ghGetFileContent`,
`ghSearchPullRequests`, `ghSearchIssues`, `ghSearchCommits`, `ghListReleases`,
`ghSearchDiscussions`, `ghCloneRepo`, `npmSearch`, `localSearch`,
`localAnalyzeGraph`, `localGetFileContent`, and `lspGetSemantics`. Treat this
list as a documentation contract; use the live catalog for exact schemas.

## Work and verify

Plan -> write a failing test -> implement -> focused test -> lint -> build ->
exercise the real CLI/MCP/Skill path -> proportional release gate.

| Task | Command |
|---|---|
| Root build | `yarn build` |
| Root tests | `yarn test` |
| Root lint and types | `yarn lint` and `yarn typecheck` |
| Full release gate | `NODE_OPTIONS=--experimental-ffi yarn verify` |
| Package gate | `yarn workspace <package-name> verify` |
| Rust tests | `cargo test --manifest-path packages/octocode-agent-core-rust/Cargo.toml` |
| Native build | `yarn workspace octocode-agent build` |
| Built native help | `node packages/octocode-agent/out/octocode-agent.mjs run --help` |
| Live protocol/tools | `npx octocode context --compact` and `npx octocode tools --json` |

After changing a package, rebuild it before claiming success. Compile-only
evidence is insufficient for host, persistence, concurrency, packaging, or UI
changes. Use real built flows for the changed boundary. Coverage target is 90%.

Access defaults: edit `packages/*/src`, tests, and docs. Ask before changing
manifests, configuration, `Cargo.toml`, or scripts. Never edit environment
files, dependencies, generated output, Rust targets, generated Skills, or SQLite
databases directly.

## External references

| Need | Source of truth |
|---|---|
| Current completion gates and open decisions | [`DESIGN/LEFTOVERS.md`](DESIGN/LEFTOVERS.md) |
| Runtime contracts | [core architecture](packages/octocode-agent-core/ARCHITECTURE.md) |
| Rust durability and filesystem services | [Rust architecture](packages/octocode-agent-core-rust/ARCHITECTURE.md) |
| Native composition and operation | [native architecture](packages/octocode-agent/ARCHITECTURE.md) and [docs](packages/octocode-agent/docs/README.md) |
| Terminal semantics and interaction | [terminal design system](packages/octocode-agent/docs/TERMINAL_DESIGN_SYSTEM.md) |
| Parallel tools, MCP, and workers | [parallelism guide](packages/octocode-agent/docs/PARALLELISM_AND_WORKERS.md) |
| Supported Pi adapter | [Pi architecture](packages/octocode-pi-extension/ARCHITECTURE.md) |
| Shared contracts | [shared architecture](packages/octocode-shared/ARCHITECTURE.md) |
| Awareness lifecycle | [Awareness guide](packages/octocode-awareness/docs/HOW_IT_WORKS.md) |
| Discovery and MCP | [discovery](docs/DISCOVERY.md) and [MCP](docs/MCP.md) |

Keep global Octocode CLI, configuration, security, OQL, and release docs in the
sibling `octocode` monorepo. Keep package internals in their owning package.
