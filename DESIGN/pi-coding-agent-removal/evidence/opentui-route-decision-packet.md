# OpenTUI runtime-route decision packet

> Scope: decision-preparation evidence for Awareness task `task_2eb4a47862614d979b207bdc`. This packet recommends the next Step 2 spike; it does not approve a runtime, change a manifest, authorize production work, or close blocker B-08.

## Decision

**HOLD production OpenTUI work and Step 2 completion. Recommend the Node.js 26.4.0 ESM plus `--experimental-ffi` route for the bounded repository spike, subject to explicit runtime/architecture, release, and security-owner approval.**

Node is the lower-change experiment because the published command, build target, SDK path, update path, and RPC child model are Node-based today. Bun is locally feasible and has the more permissive upstream version range. Selecting it now adds a second runtime or replaces the launcher, build, subprocess, installation, update, and rollback contracts before the terminal adapter has any repository seam.

This is a spike recommendation, not a production-route approval. The current OpenTUI runtime-support page says Node.js **26.4.0 exactly**, ESM, and `--experimental-ffi`; the exact pin and experimental unsafe FFI are material release and security constraints. If the spike cannot prove a maintainable Node update policy, isolated flag propagation, packaged native assets, and the supported platform matrix, the decision returns to HOLD and the Bun route must be reconsidered. No hidden `pi-tui` fallback is authorized.

## Evidence identity

| Field | Observed value |
|---|---|
| Date | 2026-08-27 |
| Workspace | `/Users/bgaryy/code/octocode-agent` |
| Inspected commit | `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` |
| Branch | `remove-pi` |
| Tracked tree | Clean when checked with `git status --short --untracked-files=all`; this ignored RFC directory is not represented by that result |
| Opening OpenTUI proof | `evidence/opentui-route-working-tree.md` at commit `3188378` |
| Integration receipt | `KPI.md` §Initial evidence integration receipt at commit `b7a3b42` |
| Published OpenTUI package | `@opentui/core@0.5.8`, confirmed by Octocode `npmSearch` on 2026-08-27 |
| Local smoke coverage | Bun 1.3.14 and Node.js 26.4.0 with experimental FFI on macOS arm64 only |
| Decision state | HOLD pending named approvals and canonical multi-platform receipt |

The opening receipt and integration rerun agree on the blocking fact: there is no repository OpenTUI dependency, adapter, composition root, or focused test seam. The earlier RFC prose that described three present files was false for the inspected repository history and has been corrected in `OPENTUI_TERMINAL_CORE.md`.

## Primary evidence

- [OpenTUI runtime and platform support](https://opentui.com/docs/getting-started/runtime-support/) states Bun 1.3.0 or later, but Node.js 26.4.0 exactly with ESM and `--experimental-ffi`. It lists eight optional native packages and warns that published artifacts do not establish parity on every target.
- [OpenTUI standalone-executable guidance](https://opentui.com/docs/reference/standalone-executables/) describes extra native-library and worker asset handling for compiled Bun executables and Node single-executable applications. The runtime-support page is treated as authoritative where its Node version wording is stricter.
- [Node.js FFI documentation](https://nodejs.org/api/ffi.html) classifies `node:ffi` as experimental and unsafe because invalid pointers, signatures, or lifetimes can crash the process or corrupt memory; access requires `--experimental-ffi`.
- [Bun runtime documentation](https://bun.sh/docs/runtime) says a Node shebang runs under Node unless Bun is explicitly forced. Therefore the existing `#!/usr/bin/env node` command does not become a Bun route merely because Bun is installed.
- [Bun standalone-executable documentation](https://bun.sh/docs/bundler/executables) supports embedding the Bun runtime in a platform executable, but that creates a new multi-platform artifact and update surface that the current npm-delivered Node command does not have.
- Octocode inspection of OpenTUI main on 2026-08-27 confirmed `@opentui/core@0.5.8`, ESM TypeScript entry points, a `web-tree-sitter` peer, eight exact-version optional native packages, and separate Node/Bun runtime-asset branches.

## Repository constraints observed today

| Constraint | Evidence | Route consequence |
|---|---|---|
| Published command is `./out/octocode-agent.mjs` | `packages/octocode-agent/package.json:23` | Both installation and command shims assume a JavaScript entry point |
| Package engine is Node.js 22 or later at `b7a3b42` | `packages/octocode-agent/package.json:30-32` | Node OpenTUI cannot run under that declared floor |
| Build is one Node 22 ESM esbuild bundle | `packages/octocode-agent/scripts/build.mjs` and root `build.config.mjs` | Node preserves the build model but needs target/externalization decisions; Bun changes it or adds another artifact |
| Generated bundle has a Node shebang | `packages/octocode-agent/scripts/build.mjs:27` | Bun requires a new shebang/wrapper or an explicit Bun executable invocation |
| Pi and the extension are external runtime dependencies | `packages/octocode-agent/scripts/build.mjs:21-26` | OpenTUI should likewise remain external during the spike so conditional exports and optional native packages resolve normally |
| SDK launch is in-process by default | `packages/octocode-agent/src/launcher.ts:1129-1135` | Node can preserve current control flow; Bun requires compatibility proof for the whole SDK-loaded graph |
| RPC serve spawns `process.execPath` | `packages/octocode-agent/src/serve.ts:171-179` | The selected runtime and any inherited flags can affect owned children |
| Print, JSON, and RPC must never initialize OpenTUI | `TEST_PLAN.md` §Mode matrix | FFI enablement and renderer imports must remain interactive-path-only |

These are current-tree observations, not permanent architecture requirements. They explain the smaller initial blast radius of the Node spike.

## Route comparison

| Dimension | Node.js 26.4.0 experimental-FFI | Bun 1.3.0 or later |
|---|---|---|
| Upstream runtime contract | Exact 26.4.0, ESM, explicit experimental flag | Version floor rather than exact version |
| Current launcher fit | High: existing command, SDK path, update code, and process APIs are Node-based | Low: Node shebang still invokes Node unless changed or explicitly forced |
| Repository engine impact | Must either narrow/raise interactive support to exact 26.4.0 or introduce a separately provisioned terminal runtime | Must require Bun, ship Bun, or compile per-platform terminal executables |
| Build impact | Preserve esbuild/ESM shape; keep OpenTUI external for the first spike | Add Bun build/compile lane or prove the full existing bundle under Bun |
| Child-process impact | Avoid global flag inheritance; headless `process.execPath` children should remain unflagged and OpenTUI-free | `process.execPath` becomes Bun if the whole command runs under Bun; every Node-assuming child path needs conformance proof |
| Package-manager impact | Keep Yarn/npm release flow; verify optional native dependencies survive install, pack, and pruning | Decide whether Yarn/npm still installs the package or Bun manages/embeds it; disable any unapproved runtime auto-install behavior |
| Native assets | Runtime branch dynamically resolves the matching optional package; packed artifact must retain it | Runtime branch resolves platform packages explicitly; compiled executables need deliberate asset inclusion and libc selection |
| Platform evidence upstream | Native packages exist for eight targets; current Node native/packed/SEA acceptance is Linux x64 only | Native packages exist for eight targets; current Bun Core tests cover macOS arm64, Linux x64, and Windows x64 |
| FFI/security | Node API is explicitly experimental and unsafe; the enabling flag is observable and controllable | Still loads native code across a Bun FFI boundary; avoids Node's experimental flag but not native-library supply-chain or memory-safety risk |
| Failure isolation | In-process renderer crash can terminate the agent unless the architecture isolates it | Same in-process risk; a separate compiled terminal child can isolate it but creates a new protocol and artifact family |
| Upgrade policy | Exact Node pin conflicts with ordinary patch upgrades until upstream support broadens or is revalidated | Bun floor is operationally easier, but Bun compatibility changes must be tested across the whole application |
| Rollback | Remove interactive flag/bootstrap and select Pi-backed host; existing Node package flow remains | Restore Node launcher/artifact and select Pi-backed host; remove Bun runtime/artifacts and their updater logic |
| User impact | Requires exact supported Node for native interactive mode unless runtime is bundled | Requires installed Bun or larger platform-specific binaries |
| Initial spike size | Smaller and directly falsifiable | Larger because it mixes terminal feasibility with host-runtime migration |

## Recommended Node spike architecture

The first spike should test a narrow Node route with these constraints:

1. Keep the published launcher and noninteractive transports on their current Node/ESM path.
2. Detect interactive native-terminal selection before importing `@opentui/core`.
3. Require Node.js 26.4.0 exactly for this spike. Do not silently accept a later Node version while the primary OpenTUI runtime page rejects it.
4. Enable `--experimental-ffi` only for the interactive native process. Do not set or depend on global `NODE_OPTIONS`, because it widens experimental FFI to updater, RPC, tools, MCP, skills, and arbitrary owned children.
5. If a bootstrap re-exec is used, pass the flag explicitly in the child argument vector, use a recursion sentinel, preserve signals and exit status, and scrub the sentinel and any OpenTUI asset override from unrelated descendants.
6. Keep `@opentui/core` external to the esbuild bundle initially. Pin the core package exactly, let its conditional exports select the Node asset path, and inspect the packed artifact plus installed dependency tree.
7. Load the renderer lazily after trust/mode selection. Print, JSON, RPC, update, doctor, auth, completion, MCP, and skill commands must prove they neither load OpenTUI nor inherit the FFI flag.
8. Treat native library and asset-root overrides as privileged configuration: reject or ignore untrusted project values, resolve real paths, constrain them to an approved installed artifact, and record the selected package/version/hash without exposing secrets.
9. Fail closed with a typed unsupported-runtime or missing-native-asset error. Never fall back silently to `pi-tui` or a different libc/architecture package.
10. Preserve the Pi-backed host selector until the terminal, package, PTY, and rollback gates pass.

This design is intentionally testable without committing to it. A production proposal must be updated from the spike's actual launcher and packaging receipts.

## Required Node spike matrix

| Area | Required cases | Pass rule |
|---|---|---|
| Runtime | Node 26.4.0 with flag; 26.4.0 without flag; current supported lower Node; one newer Node | Only the approved exact route initializes; every other case returns a typed actionable error without terminal mutation |
| Mode isolation | Interactive, print, JSON, RPC, serve, update, doctor, auth, completion | Only interactive native selection imports OpenTUI or enables FFI |
| Launcher | Direct npm bin, explicit `node`, shell shim, SDK path, subprocess fallback | Arguments, signals, exit status, environment, and one-session ownership are preserved |
| Children | RPC child, tool child, awareness CLI, Octocode CLI, updater | No unintended FFI flag or OpenTUI environment reaches a child |
| Package | Workspace build, `npm pack`, clean npm install, Yarn install, production-pruned install | Core, peer, worker, WASM, and exactly one target native package resolve from the installed artifact |
| Platform | macOS x64/arm64, Linux x64/arm64 glibc and musl, Windows x64/arm64, or an explicitly narrowed approved matrix | Install, renderer smoke, PTY lifecycle, and artifact inspection pass for every supported target |
| Terminal | Ready, input, stream, resize, Ctrl-C, termination signal, failed init, render error, crash | Exactly-once cleanup and terminal restoration; no protocol corruption |
| Security | Changed native package, path traversal/symlink asset override, untrusted project override, native-load failure | Fail closed before native execution; one redacted audit receipt |
| Performance | Cold/warm startup, first frame, frame p50/p95, peak RSS, streaming, resize, shutdown | Recorded against the canonical Pi baseline; owner approves thresholds before canary |
| Rollback | Selector to Pi host, uninstall/reinstall prior artifact, interrupted update | Previous release starts and sessions remain readable; no hidden OpenTUI dependency remains |

## Bun reconsideration trigger

Reopen the Bun route instead of weakening the Node gate if any of these occur:

- OpenTUI continues to require one exact non-LTS Node patch and the release/security owner rejects that freeze.
- The experimental FFI flag cannot be confined to the interactive native process.
- Node packed artifacts cannot resolve native, worker, WASM, or parser assets reliably on the approved matrix.
- Node FFI produces a restoration, crash, performance, or compatibility failure that Bun does not reproduce.
- The product separately approves a Bun launcher or a platform-specific terminal-child artifact strategy.

A Bun reconsideration must decide whether Bun is the whole CLI runtime, an installed terminal child, or a compiled platform artifact. These are different products and must not be conflated in one test result.

## Security implications and controls

| Risk | Required control before approval |
|---|---|
| Native memory corruption or process crash | Exact package/runtime pin, platform tests, failure containment decision, renderer teardown and PTY restoration tests |
| Native-package substitution | Lockfile integrity, clean-install/pack inspection, exact core/native version match, trusted registry/source policy |
| Asset-path injection | Protected configuration, canonical real-path containment, symlink/path traversal tests, no project-level override in untrusted workspaces |
| Experimental flag widening | Explicit interactive child argument only; reject global or inherited enabling mechanisms in the supported path |
| Optional dependency pruning | Clean production-install matrix and startup failure that names the missing target without fetching or falling back |
| Bun runtime auto-install, if reconsidered | Disable or prohibit runtime auto-install for the packaged product; require reviewed, locked artifacts |
| Child protocol contamination | Headless mode assertions and JSON/JSONL stdout purity under success and failure |
| Update/rollback mismatch | Atomic package update, version compatibility check, prior-artifact rehearsal, and session-format independence |

The renderer is not a security boundary. Trust, approval, plan, peer locks, tools, and session mutation stay in agent core; the terminal receives only semantic presentation state and returns typed interaction results.

## Approval questions

| Decision | Required owner | Recommended answer | Effect if unanswered or rejected |
|---|---|---|---|
| Authorize the Node 26.4.0 experimental-FFI spike | Runtime/architecture and security owners | Yes, for the bounded spike only | HOLD Step 2 |
| Accept an exact Node patch requirement for native interactive users during the spike | Runtime/release owner | Yes for testing; no production promise yet | HOLD production route |
| Approve explicit interactive-process flagging and prohibit supported `NODE_OPTIONS` propagation | Runtime/security owner | Yes | HOLD Node route |
| Approve exact `@opentui/core@0.5.8` spike pin and externalization | Dependency/package/security owners | Yes for spike, subject to pack inspection | No manifest change |
| Approve supported OS/architecture/libc matrix | Product/release owner | Name every supported target before implementation | No canonical route receipt |
| Approve native asset trust and override policy | Security/config owner | Managed installed assets only; untrusted project overrides forbidden | HOLD renderer load |
| Approve rollback selector and prior-artifact rehearsal | Release owner | Yes before any default change | No canary/default |
| Resolve absent prototype disposition | RFC owner | Replace it with canonical native-adapter fixtures; do not claim preservation | HOLD affected acceptance item |

## Proceed, hold, and rollback rules

- **Proceed to the bounded Node spike** only after the first four relevant owner approvals above are recorded. This permits reviewed manifest and test-seam work in a later task; it does not permit terminal parity implementation.
- **Proceed to a canonical Node route** only when every supported platform/package/PTTY/security check passes and a commit-addressed `opentui-route-<commit>.md` is approved.
- **Hold** on any missing owner, unsupported target, exact-version/update-policy conflict, FFI leakage, absent native asset, missing restoration proof, or unapproved accessibility strategy.
- **Rollback the spike** by removing the spike dependency/bootstrap and using the Pi-backed host. **Rollback after package removal** uses the prior release artifact, as required by the owning RFC.

## Validation checklist

- [x] Opening working-tree receipt and integration receipt reconciled.
- [x] False present-tense prototype and implementation claims corrected in `OPENTUI_TERMINAL_CORE.md`.
- [x] Bun and Node compared across launcher, child process, package, native asset, platform, security, user impact, update, and rollback dimensions.
- [x] Recommendation is bounded and names its falsification/reconsideration triggers.
- [x] HOLD, missing approvals, missing canonical receipt, and no-fallback rule are explicit.
- [x] No production source, manifest, lockfile, configuration, `STATUS.md`, or `KPI.md` file was edited by this task.

## Reproduction and source receipt

| Check | Observed result |
|---|---|
| `npx octocode tools npmSearch` for `@opentui/core` | Version 0.5.8; upstream `anomalyco/opentui`, `packages/core` |
| Octocode GitHub reads of `package.json`, Node/Bun runtime assets, and asset-target source | Exact package/optional-native versions, ESM exports, runtime branches, target mapping, and asset filenames inspected on main |
| Octocode local reads/searches of launcher, serve, build, bin, package, test, and KPI files | Node shebang/build/runtime and `process.execPath` child constraints reproduced at `b7a3b42` |
| Primary OpenTUI runtime/platform docs | Node exact-version and experimental-FFI contract plus native target and CI limitations recorded |
| Primary Node FFI docs | Experimental/unsafe classification and required flag recorded |
| Primary Bun runtime/executable docs | Node-shebang behavior and standalone-artifact option recorded |

This packet does not rerun the isolated renderer smokes; it relies on the verified opening receipt and integration rerun for those observed results. The next task must execute the approved route in the repository and create the canonical receipt.
