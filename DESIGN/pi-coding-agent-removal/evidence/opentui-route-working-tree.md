# OpenTUI runtime-route proof — working tree

> Scope: bounded Step 2 feasibility proof for the current working tree. This is not the canonical `opentui-route-<commit>.md` approval receipt, does not select a runtime route, and does not claim terminal parity or Step 2 completion.

## Decision

**HOLD Step 2 completion and any production OpenTUI implementation.** Both upstream-supported runtime routes work in an isolated smoke on this macOS arm64 machine, so local feasibility is positive. The repository itself has no OpenTUI dependency, native asset, adapter, or focused proof test, however, and the three prototype files cited by `OPENTUI_TERMINAL_CORE.md` are absent from the current tree and from Git history visible at this checkout. Packaging, launcher propagation, cross-platform assets, terminal restoration, PTY behavior, and runtime selection remain unproved.

The next allowed action is a reviewed implementation spike that first selects Bun or Node.js, adds the package through an approved manifest change, restores or replaces the missing test seam under the planned native adapter boundary, and produces the canonical multi-platform receipt. Do not begin terminal parity work or remove Pi based on this document.

## Evidence identity and environment

| Field | Observed value |
|---|---|
| Date | 2026-08-27 |
| Workspace | `/Users/bgaryy/code/octocode-agent` |
| Commit | `3188378dfdbe0e3ea84557b7f0796102c90feadd` |
| Branch | `main` |
| Tracked tree | Clean when checked; `git status --short --untracked-files=all`, `git diff --stat`, and `git diff --cached --stat` produced no output. The RFC directory is ignored and therefore is not represented by that result. |
| OS | macOS 26.5.2, build 25F84; Darwin 25.5.0 |
| Architecture | arm64 |
| Node.js | v26.4.0 |
| Bun | 1.3.14 |
| Yarn | 4.9.1, node-modules linker |
| OpenTUI tested | `@opentui/core@0.5.8` from npm |
| Resolved native package | `@opentui/core-darwin-arm64@0.5.8` |
| Network | Available for npm package installation and Octocode GitHub/npm inspection |
| Terminal mode | Headless in-memory test renderer only; no real PTY or interactive terminal claim |

At commit `3188378dfdbe0e3ea84557b7f0796102c90feadd`, repository engines permit Node.js versions that OpenTUI does not: the root declares Node.js `>=20.0.0`, while `octocode-agent` and `@octocodeai/pi-extension` declare `>=22.0.0`. The Node route requires Node.js 26.4.0 or later plus `--experimental-ffi`. The launcher is emitted with `#!/usr/bin/env node`, and the RPC serve path launches `process.execPath`, so choosing Node requires an engine-floor decision and reliable flag propagation to the main process and owned child processes. Choosing Bun instead requires a launcher, packaging, subprocess, install, and upgrade strategy because the inspected scripts and published bin are Node-based.

## Proof seam inventory

`OPENTUI_TERMINAL_CORE.md` names these working-tree prototype files:

- `packages/octocode-pi-extension/src/shell/opentui-adapter.ts`
- `packages/octocode-pi-extension/src/shell/opentui-view-model.ts`
- `packages/octocode-pi-extension/tests/opentui-shell.test.ts`

They are not present in this checkout. `localFindFiles` found zero files named `*opentui*` outside ignored/generated trees. Octocode text search found zero occurrences of `createOpenTuiShellUiProof`, `OpenTuiNativeSurface`, or `OpenTuiShellSnapshot` under `packages/`. LSP `workspaceSymbol` queries returned zero symbols for all three names. Structural AST queries found zero TypeScript imports from `@opentui/core` and `@opentui/core/testing` under `packages/`. `git log --all --oneline --` for the three exact paths returned no commits.

This falsifies the RFC's present-tense working-tree seam statement for commit `3188378...`. It does not prove those files never existed in an uncommitted or external tree. The canonical RFC should be corrected by its owner or the missing provenance should be supplied before the fixture-preservation requirement can be accepted.

### Focused proof-test receipt

Command:

```text
yarn workspace @octocodeai/pi-extension test:unit tests/opentui-shell.test.ts
```

Result: **exit 1**. Vitest 4.1.11 reported `No test files found`; its active include was `tests/**/*.test.ts`. Therefore no existing repository OpenTUI proof tests ran. This is a missing-input blocker, not a failing OpenTUI behavior test.

The live Pi-extension test configuration is Node-based and includes `src/**/*` and `tests/**/*` in TypeScript compilation. The Pi-extension manifest has no `@opentui/core` dependency or dev dependency. The root lockfile contains no `@opentui/core` or `opentui` entry.

## Isolated package/runtime smoke

No repository manifest or configuration was changed. A disposable directory was created at `/tmp/octocode-opentui-proof.tlZBRE`; npm initialized it and installed exactly `@opentui/core@0.5.8`. `npm ls @opentui/core @opentui/core-darwin-arm64` resolved the core package and its matching Darwin arm64 optional native package at 0.5.8.

The smoke used the documented `@opentui/core/testing` entry point and `createTestRenderer({ width: 20, height: 5 })`, rendered once, captured the character frame, and destroyed the renderer.

| Runtime command | Exit | Observed result |
|---|---:|---|
| `node --experimental-ffi --input-type=module -e '<testing-renderer smoke>'` | 0 | Renderer created; captured frame length 105; Node v26.4.0; Darwin arm64. Node emitted the expected experimental-FFI warning. |
| `bun --eval '<testing-renderer smoke>'` | 0 | Renderer created; captured frame length 105; Bun 1.3.14; Darwin arm64. |
| `node --input-type=module -e '<testing-renderer smoke>'` | 1 | Initialization failed with `OpenTUI native FFI is not available for this runtime yet`. This proves the Node flag is operationally mandatory, not merely documentation. |

This proves only import, native library resolution, in-memory renderer creation, one blank frame, and explicit destruction on the current machine. It does not exercise the repository build, esbuild externalization/bundling, published package contents, launcher startup, signals, real terminal enter/restore, input, mouse, resize, Unicode, accessibility, streaming, noninteractive isolation, or performance thresholds.

## Package and native-asset constraints

The inspected upstream 0.5.8 package exports `.` and `./testing`, publishes TypeScript/ESM entry points, declares Bun `>=1.3.0`, and documents Node.js 26.4.0+ ESM with `--experimental-ffi`. Its optional native packages cover:

| Platform | Architectures | libc variants |
|---|---|---|
| macOS | x64, arm64 | platform default |
| Linux | x64, arm64 | glibc/default and musl |
| Windows | x64, arm64 | platform default |

Node resolves a computed optional-package name such as `@opentui/core-darwin-arm64`; Bun branches explicitly by platform/architecture and uses `OPENTUI_LIBC=musl` for Linux musl. Unsupported platform/architecture values throw. The native filenames are `libopentui.dylib`, `libopentui.so`, and `opentui.dll`. The native package ABI is an internal distribution surface, not an application API.

These upstream declarations are candidates for the supported matrix, not proof that Octocode installs, bundles, publishes, or executes every artifact. Optional-dependency pruning, lockfile behavior, archive contents, Yarn install modes, libc detection, Windows spawning, and macOS/Linux/Windows CI remain untested here.

## Supported and unsupported paths today

| Path | Current evidence | Status |
|---|---|---|
| Bun 1.3.14 + npm-installed 0.5.8 + Darwin arm64 test renderer | Isolated renderer smoke succeeds | Locally feasible only |
| Node 26.4.0 ESM + `--experimental-ffi` + npm-installed 0.5.8 + Darwin arm64 test renderer | Isolated renderer smoke succeeds | Locally feasible only |
| Node 26.4.0 without FFI flag | Deterministic initialization failure | Unsupported |
| Existing repository OpenTUI proof test | Named file absent; focused command exits 1 | Blocked |
| Existing repository OpenTUI production route | No package, import, native asset, adapter, or composition caller | Not implemented |
| Packaged `octocode-agent` route | Current Node/shebang/esbuild route inspected, but no OpenTUI dependency is packaged | Unproved |
| Linux glibc/musl, Windows, macOS x64 | Upstream packages declared only | Unproved |
| Real terminal lifecycle and restoration | No PTY or product adapter | Unproved |
| Print, JSON, RPC isolation | No product OpenTUI composition exists | Unproved |

## Production gaps before a route can be selected

1. Decide Bun versus Node and name the supported runtime/version policy.
2. For Node, approve the Node 26.4+ engine floor and prove `--experimental-ffi` propagation through the published bin, RPC child launch, updates, shell invocation, and all supported entry points.
3. For Bun, approve changing or wrapping the current Node bin/build/runtime model and prove Node-dependent CLI, MCP, skills, auth, subprocess, and update behavior.
4. Add and pin `@opentui/core` in the native adapter package through a reviewed manifest/lockfile change; decide whether esbuild externalizes it and how source/asset entry points ship.
5. Resolve the missing prototype provenance or replace it with a canonical `packages/octocode-agent/src/terminal/opentui/` test seam. Do not make the Pi extension the native terminal owner.
6. Test package install and native asset resolution on macOS x64/arm64, Linux x64/arm64 glibc and musl, and Windows x64/arm64, or approve a narrower release support matrix.
7. Add deterministic `@opentui/core/testing` coverage for frame, input, mouse, resize, focus, clock, capability variants, and exactly-once destruction.
8. Add real PTY coverage for startup failure, normal exit, Ctrl-C, termination signals, crash, resize, Unicode, narrow terminals, and terminal restoration.
9. Prove print, JSON, RPC, and other headless modes never initialize OpenTUI and keep stdout/stderr protocol-pure.
10. Measure cold/warm startup, first frame, p50/p95 frame duration, peak RSS, sustained streaming, resize recovery, and shutdown against approved KPI thresholds.
11. Inspect the built and packed artifact, test rollback, and produce `evidence/opentui-route-<commit>.md` on a named reviewable commit.

## Unresolved approvals

| Decision | Required owner/approval | Blocking effect |
|---|---|---|
| Bun or Node route | Runtime/architecture owner | Blocks dependency and launcher design |
| Node engine floor and experimental flag, if Node | Runtime/release owner | Blocks supported installation contract |
| Bun launcher/distribution change, if Bun | Runtime/release owner | Blocks published binary contract |
| Exact OpenTUI version and update policy | Dependency/security owner | Blocks manifest/lockfile change |
| Supported OS/architecture/libc matrix | Product/release owner | Blocks canonical platform gate |
| Missing prototype provenance and fixture disposition | RFC owner | Blocks the stated preserve/generalize acceptance item |
| Native package placement and esbuild externalization | Package owner | Blocks packed-artifact proof |
| Terminal accessibility/alternate-output strategy | Product/accessibility owner | Blocks terminal parity |

## Reproduction commands and observed exits

| Command | Exit/result |
|---|---|
| `npx octocode tools localFindFiles ... '*opentui*'` | 0; zero files outside ignored/generated trees |
| `npx octocode tools localSearchCode ... createOpenTuiShellUiProof\|OpenTuiNativeSurface\|OpenTuiShellSnapshot` | 0; zero package matches |
| `npx octocode tools lspGetSemantics ... workspaceSymbol` for each named symbol | 0; LSP available, zero symbols |
| Structural AST import queries for `@opentui/core` and `@opentui/core/testing` | 0; zero matches |
| `git log --all --oneline -- <three cited paths>` | 0; no output |
| `yarn workspace @octocodeai/pi-extension test:unit tests/opentui-shell.test.ts` | 1; no test files found |
| `npm install @opentui/core@0.5.8` in disposable directory | 0; 12 packages added, zero audit vulnerabilities reported |
| `npm ls @opentui/core @opentui/core-darwin-arm64` | 0; both resolved at 0.5.8 |
| Node renderer smoke with `--experimental-ffi` | 0 |
| Bun renderer smoke | 0 |
| Node renderer smoke without `--experimental-ffi` | 1; FFI unavailable |

## Evidence sources

- Local RFC requirements: `OPENTUI_TERMINAL_CORE.md` and `TEST_PLAN.md`.
- Local manifests/configuration: root, `packages/octocode-agent`, and `packages/octocode-pi-extension` package manifests; `.yarnrc.yml`; Pi-extension TypeScript and Vitest configuration; launcher bin/build sources.
- Local static proof: Octocode file/content/structural search and LSP workspace-symbol results.
- Upstream package identity: npm `@opentui/core@0.5.8`.
- Upstream source inspected through Octocode GitHub tools: [`packages/core/package.json`](https://github.com/anomalyco/opentui/blob/main/packages/core/package.json), [`packages/core/README.md`](https://github.com/anomalyco/opentui/blob/main/packages/core/README.md), [`runtime-assets.node.ts`](https://github.com/anomalyco/opentui/blob/main/packages/core/src/platform/runtime-assets.node.ts), [`runtime-assets.bun.ts`](https://github.com/anomalyco/opentui/blob/main/packages/core/src/platform/runtime-assets.bun.ts), and [`node-asset-target.ts`](https://github.com/anomalyco/opentui/blob/main/packages/core/src/node-asset-target.ts).

## Self-check

- Only this assigned evidence file was created.
- No production source, manifest, lockfile, configuration, status page, or other RFC document was edited.
- The existing proof-test command was attempted and its missing-file failure is recorded without converting it into a behavior failure.
- Both available supported runtime routes were exercised with the exact package and resolved native artifact on this host.
- Unsupported paths, platform limitations, packaging gaps, and approvals are explicit.
- No terminal parity, route approval, canonical receipt, or Step 2 completion is claimed.
