# Pi version support investigation

Status: **working-tree evidence and proposed policy; not an approved support matrix**  
Captured: `2026-08-27`  
Repository commit: `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac`  
Awareness task: `task_77074dd2b24246009ef64b8b` in plan `plan_4eddec41599f470ba5a5e292`  
Decision: **hold B-05 open**

This receipt inventories the captured Pi-family dependency contract, the compatibility-sensitive APIs used by Octocode, the tests that exercise those seams, and a proposed version policy. It does not change a manifest or lockfile, does not claim that an uninstalled Pi version works, and does not authorize Pi removal.

## Evidence classification

The labels in this document are intentional:

- **Observed** means reproduced from this repository, its lockfile, an executed check, npm package metadata, or tag-addressed upstream source.
- **Proposed** means a policy or future test requirement offered for owner review. It is not a product promise.
- **Approved** requires the runtime, extension, release, and security owners named by `PREREQUISITES.md`. No version row is approved by this receipt.

## Capture environment

| Field | Observed value |
|---|---|
| Repository | `/Users/bgaryy/code/octocode-agent` |
| Commit | `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` |
| Tracked working tree | `git status --short` returned no rows before the executable checks |
| RFC visibility | `.octocode/` is ignored; this receipt is not commit-addressed merely because the tracked tree is clean |
| Node | `v26.4.0` |
| Yarn | `4.9.1` |
| Host | Darwin arm64 |
| Installed Pi host | `@earendil-works/pi-coding-agent@0.84.2` |
| Installed Pi TUI | `@earendil-works/pi-tui@0.84.2` |
| Upstream package metadata observed | npm and the `earendil-works/pi` repository reported `0.84.3` as the current release on 2026-08-27 |

## Observed declared and resolved dependency graph

| Consumer/source | Package | Declaration | Resolved | Meaning |
|---|---|---:|---:|---|
| `packages/octocode-agent/package.json` dependency | `@earendil-works/pi-coding-agent` | `0.84.2` | `0.84.2` | The branded launcher has an exact host pin. |
| `packages/octocode-pi-extension/package.json` dev dependency | `@earendil-works/pi-coding-agent` | `0.84.2` | `0.84.2` | Extension types and local tests compile against one exact host version. |
| Extension optional peer | `@earendil-works/pi-coding-agent` | `^0.84.2` | Host-supplied | For a `0.x` package, this range admits `>=0.84.2 <0.85.0`, including patch releases without executable evidence in this receipt. |
| Extension runtime dependency | `@earendil-works/pi-tui` | `^0.84.2` | `0.84.2` | The extension directly imports Pi terminal APIs and relies on host aliasing to the host copy. |
| Pi host transitive family | `pi-agent-core`, `pi-ai`, `pi-client`, `pi-protocol`, `pi-tui` | `^0.84.2` from Pi `0.84.2` | `0.84.2` each in this lock | The installed graph is a coherent `0.84.2` family. |

`yarn why` independently reproduced the launcher-owned `pi-coding-agent@0.84.2` path and the host/extension-owned `pi-tui@0.84.2` paths. The lockfile records one `pi-coding-agent@npm:0.84.2` resolution and one `pi-tui@npm:0.84.2` resolution. No second Pi host version is installed.

The public extension manifest therefore has a policy mismatch: its peer range is broader than its executable evidence. A semver-compatible declaration is not proof of behavioral compatibility for an extension host.

## Primary package and source metadata

`npmSearch` resolved all six Pi-family packages to the same primary repository and package directories:

| Package | Primary directory | Metadata result on capture date |
|---|---|---|
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | Latest `0.84.3`; MIT; `earendil-works/pi` |
| `@earendil-works/pi-tui` | `packages/tui` | Latest `0.84.3`; same repository |
| `@earendil-works/pi-agent-core` | `packages/agent` | Latest `0.84.3`; same repository |
| `@earendil-works/pi-ai` | `packages/ai` | Latest `0.84.3`; same repository |
| `@earendil-works/pi-client` | `packages/client` | Latest `0.84.3`; same repository |
| `@earendil-works/pi-protocol` | `packages/protocol` | Latest `0.84.3`; same repository |

Tag-addressed upstream manifests prove that Pi `v0.84.2` depends on its five sibling packages with `^0.84.2`, while `v0.84.3` advances the family to `^0.84.3`. Both declare Node `>=22.19.0`. Sources:

- [Pi coding-agent manifest at v0.84.2](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/package.json)
- [Pi coding-agent manifest at v0.84.3](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/package.json)
- [Pi extension API source at v0.84.2](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/extensions/types.ts)
- [Pi extension API source at v0.84.3](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/extensions/types.ts)
- [Pi extension documentation at v0.84.3](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/extensions.md)
- [Pi coding-agent changelog at v0.84.3](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/CHANGELOG.md)
- [Pi TUI changelog at v0.84.3](https://github.com/earendil-works/pi/blob/v0.84.3/packages/tui/CHANGELOG.md)

## Observed compatibility-sensitive Octocode surface

### Published Pi types imported at compile time

`packages/octocode-pi-extension/src/types.ts` imports these public host types:

`BuildSystemPromptOptions`, `ContextUsage`, `ExtensionAPI`, `ExtensionCommandContext`, `ExtensionContext`, `ExtensionUIContext`, `ReadonlyFooterDataProvider`, `ToolDefinition`, `ToolRenderResultOptions`, `WorkingIndicatorOptions`, and `Theme`.

The same file then supplies broad local compatibility interfaces. Current LSP evidence shows:

| Local boundary | LSP references | Files | Interpretation |
|---|---:|---:|---|
| `PiInstance` at `types.ts:517` | 67 | 21 | Operational host surface used by the extension, hook composer, scheduler, and tools. |
| `PiContext` at `types.ts:323` | 227 | 25 | High-coupling context surface; the count increased from the earlier receipt because the working tree evolved. |
| `ShellRuntime` at `shell/shell.ts:80` | 8 | 4 | Structural SDK/session seam used by shell composition and tests. |

The TypeScript LSP served definitions and references. Pull diagnostics were unsupported because the active server uses push diagnostics; successful workspace typechecks below provide the executable diagnostic receipt.

### Host API methods used now

The current semantic inventory proves these invoked `PiInstance` families:

- lifecycle subscription through `on`;
- tools through `registerTool`, `getActiveTools`, and `setActiveTools`;
- commands, shortcuts, and flags through `registerCommand`, `getCommands`, `registerShortcut`, `registerFlag`, and `getFlag`;
- messages and durable presentation through `sendUserMessage`, `sendMessage`, `registerMessageRenderer`, `appendEntry`, and `registerEntryRenderer`;
- model/session state through `getThinkingLevel`, `setThinkingLevel`, `setModel`, `getSessionName`, and `setSessionName`;
- process execution through `exec`.

The local interface additionally declares `getAllTools`, `setLabel`, provider registration, and a host event bus. These must be classified as used, adapter-only, or unused before the canonical adapter ABI is frozen; declaration alone is not proof of runtime use.

### Lifecycle events used now

The existing semantic receipt proves 19 production-used Pi event names across direct listeners and the hook composer:

`resources_discover`, `tool_call`, `session_tree`, `session_start`, `session_shutdown`, `model_select`, `thinking_level_select`, `input`, `tool_execution_start`, `tool_execution_end`, `before_provider_request`, `after_provider_response`, `before_agent_start`, `turn_start`, `turn_end`, `agent_start`, `agent_end`, `session_before_compact`, and `session_compact`.

Compatibility-sensitive semantics include handler ordering; blocking and rewriting; input source and streaming behavior; session reason and identity; compaction reason/retry state; tool call/update/result identity; provider request/response data; and whether callbacks can mutate session, model, UI, or external state.

### Context, session, tool, and renderer interfaces

- `PiContext` supplies cwd, mode, UI availability, model, trust, context usage, compaction, session manager, and model registry.
- `PiCommandContext` adds reload, new/switch/fork/tree navigation, idle waiting, and rich user-message delivery. Those methods must stay command-scoped to avoid host deadlocks.
- `PiSessionManager` usage proves session ID/file, branch, and entry access. The local declaration also carries tree, leaf, label, header, and name accessors.
- The tool ABI couples TypeBox parameters, argument preparation, `execute(toolCallId, params, signal, onUpdate, ctx)`, text/image result parts, and `renderCall`/`renderResult` state.
- The UI surface includes dialog, custom overlay, terminal input, status/widget/header/footer, editor, theme, tool-expansion, working indicator, and invalidation behavior.
- The structural shell seam uses `AgentSession.prompt`, `subscribe`, `abort`, `isStreaming`, and assistant/tool event shapes.

### Runtime and private imports

Three public coding-agent runtime imports are version-sensitive:

| File | API |
|---|---|
| `src/tools/bash-tool.ts` | `getShellConfig` |
| `src/tools/dynamic-skills.ts` | `parseFrontmatter`, `stripFrontmatter` |
| `src/tools/image-render.ts` | `SettingsManager` |

`src/tools/export-command.ts` additionally loads the non-exported `dist/core/export-html/index.js` path. This is outside the package export map and is more fragile than the declared peer range; every supported version must test it until an owned exporter replaces it.

The extension directly imports Pi TUI APIs used for rendering and terminal behavior: `Container`, `Editor`, `ProcessTerminal`, `Text`, `TuiMainScreen`, `EditorTheme`, `SelectListTheme`, `CURSOR_MARKER`, `Input`, `Key`, `matchesKey`, `wrapTextWithAnsi`, `Image`, `detectCapabilities`, `SelectList`, `truncateToWidth`, and `visibleWidth`. Host aliasing and exact TUI-family alignment are part of compatibility, not an implementation detail.

The launcher separately depends on Pi SDK/runtime exports for SDK creation, interactive/print/RPC dispatch, settings, sessions, and protocol types. Its direct `serve.ts` RPC type import and SDK/subprocess resolution paths must be included in the version matrix even though this RFC ultimately removes them from the native host.

## Observed change risk from `0.84.2` to `0.84.3`

The upstream compare contains 105 commits. The extension-type file alone changed by 49 additions and 8 deletions. Relevant changes are:

| Change | Compatibility impact for Octocode |
|---|---|
| New `session_compact_failed` event | The current extension does not subscribe to it. A supported `0.84.3` adapter must classify/map it rather than silently losing failure lifecycle data. |
| New optional PowerShell tool event variants | Tool-event normalization and default-tool inventories can differ on Windows. |
| `registerFlag` typing corrected to a boolean/string discriminated union | Current local compatibility typing is permissive; compile and behavioral fixtures must prove both flag kinds. |
| Failed extension factories now discard partial state | Activation/unload tests must detect leaked registrations on older and newer hosts. |
| JSON/RPC `toolcall_start` now includes call ID and name | Wire-normalization fixtures can legitimately diverge across the two patch releases and need an explicit adapter rule. |
| Model/thinking selection became session-scoped unless explicitly persisted | Settings/model state tests must distinguish session selection from default persistence. |
| Node CLI/RPC entrypoints moved to a bundled runtime path | Launcher SDK/RPC/package activation and private/deep imports need real package tests, not typecheck alone. |
| TUI narrow-width, paste, and Markdown color fixes | Terminal snapshots and input behavior may differ while public imports remain source-compatible. |
| Changelog declares a breaking inherited Pi-AI type rename | The full Pi-family version must be tested together; host-only version substitution is unsafe. |

This proves that patch-level movement in the current peer range can change lifecycle, protocol, activation, model/settings, and terminal behavior. It does not prove `0.84.3` is incompatible; it proves that compatibility must be executed.

## Test evidence

No test file contains the literal installed version `0.84.2`, and no test names a supported-Pi-version matrix or an unsupported-host rejection. Existing tests use local structural mocks plus whichever single Pi family the lockfile installs.

On this capture, the following exact commands passed:

| Command | Result |
|---|---|
| `yarn workspace @octocodeai/pi-extension vitest run tests/factory.test.ts tests/mock-pi-host-flow.test.ts tests/pi-api-types.test.ts tests/shell.test.ts tests/render-helpers.test.ts` | Exit 0; 5 files and 28 tests passed; 0 failed. |
| `yarn workspace octocode-agent vitest run tests/launcher.test.ts tests/sdk-launcher.test.ts` | Exit 0; 2 files and 159 tests passed; 0 failed. |
| `yarn workspace @octocodeai/pi-extension typecheck` | Exit 0. |
| `yarn workspace octocode-agent typecheck` | Exit 0. |

These checks corroborate source compatibility and mocked behavior for the installed `0.84.2` graph. They do not exercise package activation against `0.84.3`, an unsupported version, a mixed-family graph, a published extension artifact, or all required host-conformance scenarios.

## Proposed support matrix

The following is a review proposal only:

| Host version | Proposed classification | Required evidence before approval |
|---|---|---|
| `0.84.2` | Minimum supported and baseline | Re-run the full published-artifact activation and host-conformance suite on every release platform. Current focused evidence is necessary but insufficient. |
| `0.84.3` | Supported patch candidate | Install the coherent `0.84.3` family and pass the same suite; add explicit fixtures for compaction failure, PowerShell events, factory rollback, RPC tool-call identity, model persistence, and TUI differences. |
| Future `>=0.84.4 <0.85.0` | Candidate, not automatically supported | Review tag-addressed API/changelog diff and pass the complete matrix before adding the exact version to the tested-version allowlist. |
| `<0.84.2` | Unsupported | Fail activation clearly. The shell comment referencing `0.80.3` is historical structural evidence, not a support promise. |
| `>=0.85.0` | Unsupported until a new compatibility review | Require explicit owner approval, adapter diff, migration notes, and full conformance. |
| Prerelease, git, or mismatched Pi-family graph | Unsupported by default | Require an explicit development override that is never presented as release support. |

The proposed public rule has three parts:

1. Support only exact Pi host versions named in a generated and tested allowlist.
2. Keep the manifest range no broader than the approved tested set.
3. Reject unknown versions before registering any contribution.

If release owners prefer a range, CI must test its minimum plus every published patch named by that range. Each subsequent patch must remain unsupported until the matrix passes.

No manifest change should occur until this policy is approved. In particular, this receipt does not recommend silently widening the launcher pin to `0.84.3` or treating the existing `^0.84.2` peer declaration as sufficient evidence.

## Required version-matrix implementation

The future matrix runner should create an isolated install for each exact host version and test the packed extension artifact, not the workspace source graph. For each row it must:

1. Resolve and record the host version, all Pi-family versions, Node/Yarn/npm versions, OS, architecture, and artifact hashes.
2. Reject a mixed family unless upstream explicitly publishes and Octocode approves that combination.
3. Install the packed `@octocodeai/pi-extension` artifact with the exact host.
4. Activate the extension through Pi's real package loader and through the launcher's supported SDK path while that path remains in scope.
5. Run the shared host-conformance scenarios from `TEST_PLAN.md`, including tools, commands, lifecycle, sessions, compaction, model/thinking, UI fallback, print, JSON, RPC, cancellation, and shutdown.
6. Run adapter-specific cases for unsupported-version failure, privilege narrowing, renderer-only contributions, session identity, and exact event mapping.
7. Run every direct public import and the private exporter load; report the first divergence and normalized trace hashes.
8. Verify activation failure leaves zero handlers, tools, commands, providers, renderers, processes, timers, files, or terminal state behind.
9. Preserve the exact install graph and machine-readable result as release evidence.

### Proposed future commands

These commands are specifications for scripts that do not exist yet; their absence is part of B-05:

```text
yarn workspace @octocodeai/pi-extension build
yarn workspace @octocodeai/pi-extension test:pi-contract
yarn workspace @octocodeai/pi-extension test:pi-version --pi-version 0.84.2
yarn workspace @octocodeai/pi-extension test:pi-version --pi-version 0.84.3
yarn workspace @octocodeai/pi-extension test:pi-version --pi-version 0.84.1 --expect-unsupported
yarn workspace @octocodeai/pi-extension test:pi-version --pi-version 0.85.0 --expect-unsupported
yarn workspace octocode-agent test:pi-version --pi-version 0.84.2
yarn workspace octocode-agent test:pi-version --pi-version 0.84.3
```

The runner must return nonzero for an expected-supported row that fails and for an expected-unsupported row that activates. It must never mutate repository manifests or the canonical lockfile; all installs belong in isolated temporary roots.

## Approval gate and unresolved work

B-05 remains open because:

- only `0.84.2` is installed and executed;
- `0.84.3` is inside the declared peer range but has no local activation or conformance receipt;
- no runtime version detector or exact tested-version allowlist exists;
- no negative unsupported-version test exists;
- no published-artifact, mixed-family, or multi-platform matrix exists;
- the compatibility window and owner sign-off have not been approved.

Required approvers must decide the minimum version, the exact supported set or range, patch-admission policy, deprecation window, and emergency rollback behavior. Until then, the operational release statement is: **observed working graph `0.84.2`; all broader support unapproved.**

## Reproduction commands

The investigation used these read-only or test commands:

```text
git rev-parse HEAD
git status --short
node --version
yarn --version
yarn why @earendil-works/pi-coding-agent
yarn why @earendil-works/pi-tui
npx octocode tools localGetFileContent localSearchCode localFindFiles lspGetSemantics npmSearch ghSearchCode ghGetFileContent ghSearchCommits --scheme
npx octocode tools npmSearch --queries <Pi-family exact-package queries>
npx octocode tools localSearchCode --queries <manifest, lockfile, import, test, and RFC queries>
npx octocode tools localGetFileContent --queries <exact manifest/source/test/RFC reads>
npx octocode tools lspGetSemantics --queries <PiInstance, PiContext, and ShellRuntime reference queries>
npx octocode tools ghGetFileContent --queries <v0.84.2 and v0.84.3 primary-source reads>
npx octocode tools ghSearchCommits --queries <v0.84.2...v0.84.3 source comparisons>
yarn workspace @octocodeai/pi-extension vitest run tests/factory.test.ts tests/mock-pi-host-flow.test.ts tests/pi-api-types.test.ts tests/shell.test.ts tests/render-helpers.test.ts
yarn workspace octocode-agent vitest run tests/launcher.test.ts tests/sdk-launcher.test.ts
yarn workspace @octocodeai/pi-extension typecheck
yarn workspace octocode-agent typecheck
```

Angle-bracket query descriptions above stand for the exact JSON query bodies captured in the tool-call transcript; they are not claimed as executable shell literals.

## Self-check

- [x] Declared, peer, transitive, and resolved Pi-family versions recorded.
- [x] npm metadata tied to the upstream primary repository.
- [x] Tag-addressed `0.84.2` and `0.84.3` manifests and extension API source inspected.
- [x] Compatibility-sensitive APIs, interfaces, events, runtime imports, private import, TUI imports, SDK, and RPC seams recorded.
- [x] AST/search candidates corroborated with exact reads and LSP reference evidence.
- [x] Existing tests distinguished from a real multi-version matrix.
- [x] Proposed support policy distinguished from observed and approved state.
- [x] Exact current validation commands and results recorded.
- [x] Future matrix requirements and unsupported-version behavior specified.
- [x] No manifest, lockfile, config, production source, RFC status, or blocker state changed.
- [x] B-05 remains open.
