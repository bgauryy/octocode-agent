# Stage 0 semantic Pi API inventory

Status: evidence snapshot for the Stage 0 migration investigation; **not a canonical baseline and not a Stage 0 completion claim**.

Captured: 2026-08-27 (Asia/Jerusalem)

## Scope and repository state

This inventory covers `packages/octocode-agent/src` and `packages/octocode-pi-extension/src`. Tests were inspected only to corroborate reachability. No production code, manifest, RFC status, or other RFC document was changed.

The first repository-state receipt was commit `56c572c2c69ce79e1a261d365736ed40ce2fa611` with an empty `git status --short`. During this concurrent run, HEAD advanced to `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac`; the final `git status --short`, `git diff --stat`, and `git diff --cached --stat` were also empty before this ignored evidence file was written. This moving HEAD is why the result is a scoped evidence snapshot rather than a frozen baseline.

## Tool contract and exact query shapes

The live schemas were read with:

```text
npx octocode tools localGetFileContent --scheme
npx octocode tools localSearchCode localViewStructure lspGetSemantics --scheme
```

Material searches used these exact Octocode query shapes (absolute paths were supplied at execution time):

```json
{"path":"<repo>/packages/octocode-{agent,pi-extension}/src","searchText":"@mariozechner/pi|pi-coding-agent|pi-ai|pi-tui","regex":"perl","include":["*.ts"],"mode":"detailed","contextLines":2,"sort":"path"}
{"path":"<repo>/packages/octocode-pi-extension/src","mode":"structural","pattern":"import { $$$NAMES } from '@earendil-works/pi-coding-agent'","langType":"ts","captureText":true,"sort":"path"}
{"path":"<repo>/packages/octocode-pi-extension/src","mode":"structural","pattern":"import { $$$NAMES } from '@earendil-works/pi-tui'","langType":"ts","captureText":true,"sort":"path"}
{"path":"<repo>/packages/octocode-pi-extension/src","searchText":"\\bpi\\.[A-Za-z][A-Za-z0-9_]*(?:\\?\\.)?\\(","regex":"perl","include":["*.ts"],"output":"matchOnly","unique":"count","sort":"path"}
{"path":"<repo>/packages/octocode-pi-extension/src","searchText":"(?<=\\bpi\\.on\\(['\\\"])[^'\\\"]+","regex":"perl","include":["*.ts"],"output":"matchOnly","unique":"count","sort":"path"}
{"path":"<repo>/packages/octocode-pi-extension/src","searchText":"hooks\\.on\\(['\\\"]","regex":"perl","include":["*.ts"],"mode":"detailed","contextLines":1,"sort":"path"}
{"path":"<repo>/packages/octocode-pi-extension/src","searchText":"\\bctx\\.(?:newSession|sendUserMessage|reload|fork|navigateTree|switchSession|waitForIdle|compact)(?:\\?\\.)?\\(","regex":"perl","include":["*.ts"],"mode":"detailed","contextLines":1,"sort":"path"}
```

Files and exact regions were then read with `localGetFileContent` using `fullContent`, `startLine`/`endLine`, or `matchString`; source structure came from `localViewStructure` with `recursive:true`, `maxDepth:4|5`, and `itemsPerPage:50`.

Semantic proof used `lspGetSemantics` with absolute `uri`, real `lineHint`, `workspaceRoot:<repo>`, and `type:references|callers|diagnostic`. Reference queries used `includeDeclaration:true`, `groupByFile:true`, and `itemsPerPage:100`.

## Launcher and process dependency

`packages/octocode-agent` has two live host routes plus an RPC envelope dependency:

1. `sdk-launcher.ts:166-168` dynamically imports `@earendil-works/pi-coding-agent`. `launchWithSdk` destructures nine SDK members: `createAgentSessionRuntime`, `createAgentSessionFromServices`, `createAgentSessionServices`, `getAgentDir`, `InteractiveMode`, `runPrintMode`, `runRpcMode`, `SessionManager`, and `SettingsManager`.
2. The SDK path creates/reopens/in-memory sessions, applies settings overrides, injects `createOctocodePiExtension` through `extensionFactories`, creates services/session/runtime, and dispatches interactive, print, or RPC mode. `launcher.ts:1131-1135` prefers this path unless `OCTOCODE_LAUNCHER_MODE=subprocess`.
3. The subprocess fallback resolves `OCTOCODE_PI_BIN`, `OCTOCODE_PI_PACKAGE`, or the default `@earendil-works/pi-coding-agent`; `launcher.ts:1152` spawns the resolved Pi binary with extension arguments.
4. `serve.ts:4-9` imports `RpcCommand`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, and `RpcResponse`; it spawns the agent entry point in raw RPC mode and forwards JSON lines.

The local `PiSdkModule` type is only `Record<string, unknown>` (`octocode-agent/src/types.ts`), so the nine-member SDK surface is runtime-checked/cast rather than compiler-verified.

LSP receipts:

- `importPiSdk` (`sdk-launcher.ts:166`): 2 references in its defining file (declaration and call at line 229).
- `launchWithSdk` (`sdk-launcher.ts:214`): 28 references across 3 files, including `launcher.ts:1103` and 26 test references. Call hierarchy reported zero callers because the production edge is a dynamic import; the tool explicitly reported `dynamicCallsExcluded:true`.
- `resolvePiBin` (`launcher.ts:185`): 7 references across launcher/tests. Call hierarchy proved `configReport` and `configData`; the launch-site dependency is also visible at `launcher.ts:1139`.

## Extension host API surface used now

`types.ts:9-21` imports these published Pi types: `BuildSystemPromptOptions`, `ContextUsage`, `ExtensionAPI`, `ExtensionCommandContext`, `ExtensionContext`, `ExtensionUIContext`, `ReadonlyFooterDataProvider`, `ToolDefinition`, `ToolRenderResultOptions`, `WorkingIndicatorOptions`, and `Theme`. `PiApi` aliases `ExtensionAPI` but LSP found only its declaration; the operational contract is the local `PiInstance` structural interface.

The syntactic invocation query found **95 `pi.<method>(...)`/optional-call occurrences in 17 source files**. Frequencies are:

| API | Calls | API | Calls |
|---|---:|---|---:|
| `on` | 20 | `registerCommand` | 27 |
| `getThinkingLevel` | 9 | `getCommands` | 7 |
| `appendEntry` | 5 | `sendUserMessage` | 5 |
| `sendMessage` | 3 | `getActiveTools` | 3 |
| `exec` | 2 | `setActiveTools` | 2 |
| `getSessionName` | 2 | `registerShortcut` | 2 |
| `registerMessageRenderer` | 2 | `setModel` | 1 |
| `registerEntryRenderer` | 1 | `registerFlag` | 1 |
| `setSessionName` | 1 | `getFlag` | 1 |
| `setThinkingLevel` | 1 | `registerTool` | 1 |

The `registerTool` count is the host boundary (`tools/octocode-tools.ts:120`), not the number of tool definitions passed through that registrar. Likewise command frequency is registration call sites, not command execution count.

At the captured revisions, the extension subscribes to **19 unique Pi event names** through direct `pi.on` and `HookComposer`: `resources_discover`, `tool_call`, `session_tree`, `session_start`, `session_shutdown`, `model_select`, `thinking_level_select`, `input`, `tool_execution_start`, `tool_execution_end`, `before_provider_request`, `after_provider_response`, `before_agent_start`, `turn_start`, `turn_end`, `agent_start`, `agent_end`, `session_before_compact`, and `session_compact`. There are 17 `hooks.on` registrations in `index.ts`; repeated registrations exist for `tool_call` and `input`.

Other central host-facing contracts proven in source are:

- `PiContext`: cwd, mode/UI/model state, project trust, context usage, compaction/session state, model registry, and session-control access. LSP returned 179 references across 20 files.
- `PiCommandContext`: `reload` is invoked from the skills-update command and `navigateTree` from rewind; the local interface also declares new/fork/switch/wait capabilities that require separate use-by-use proof before implementation.
- `PiSessionManager`: current syntactic calls prove `getSessionId`, `getSessionFile`, `getBranch`, and `getEntries` (9 occurrences in 4 files).
- `PiUi`: current calls prove notifications, confirm/select/input/editor/custom interaction, theme/title, status/widget/footer, working-indicator/message/visibility, editor text, and autocomplete paths. Some calls are routed through helpers/stores, so a single `ctx.ui` regex is not a complete call count.
- Tool ABI: TypeBox-compatible `parameters`; `execute(toolCallId, params, signal, onUpdate, ctx)`; text/image result parts; `renderCall`/`renderResult`; partial/expanded/error/render invalidation state.
- Durable/transient presentation: custom messages and renderers, custom entries and entry renderers, command/shortcut/flag registration, active-tool scoping, model/thinking selection, session naming, user-message delivery, and host exec.

LSP receipts:

- `PiInstance` (`types.ts:517`): 67 references across 21 files, including the hook composer, extension root, scheduler, and 17 tool modules.
- `PiApi` (`types.ts:25`): declaration only; do not treat it as the operative abstraction.
- `PiContext` (`types.ts:323`): 179 references across 20 files.
- `PiUi` (`types.ts:235`): 4 type references across the declaration and `pi-api-types.test.ts`; most consumers reach it through `PiContext.ui`, explaining the low direct type-reference count.
- Pull diagnostics were unavailable for `types.ts` and `sdk-launcher.ts`; the TypeScript server reported that it uses push diagnostics. This run therefore makes no diagnostic-clean claim.

## Direct package imports and dynamic loads

AST structural search proved three runtime `pi-coding-agent` import declarations in the extension:

| File | Imported runtime API | Current use |
|---|---|---|
| `tools/bash-tool.ts:14` | `getShellConfig` | Select host shell before spawning a command. |
| `tools/dynamic-skills.ts:23` | `parseFrontmatter`, `stripFrontmatter` | Parse/validate dynamically discovered skill Markdown. |
| `tools/image-render.ts:25` | `SettingsManager` | Read `showImages` configuration. |

`tools/export-command.ts:118-127` dynamically loads the unexported deep module `dist/core/export-html/index.js`, first by package specifier and then through `import.meta.resolve` plus a file URL. LSP found 4 references to `defaultImportExporter` across its implementation and tests. This is a fragile private-module dependency and needs an owned exporter before Pi removal.

AST structural search proved eight runtime `pi-tui` import declarations. Exact reads add the double-quoted `SelectList` import and a type-only shell import, yielding **10 source files with 14 textual `pi-tui` occurrences** (comments included in the occurrence total). At the captured revisions, the imported runtime/type APIs are:

`Container`, `Editor`, `ProcessTerminal`, `Text`, `TuiMainScreen`, `EditorTheme`, `SelectListTheme`, `CURSOR_MARKER`, `Input`, `Key`, `matchesKey`, `wrapTextWithAnsi`, `Image`, `detectCapabilities`, `SelectList`, `truncateToWidth`, and `visibleWidth`.

These support terminal lifecycle/rendering/editor input, key decoding, overlays, ANSI-safe width, wrapping, image capability detection/rendering, and the current custom shell. They are a separate removal track from `pi-coding-agent` and map directly to the planned OpenTUI terminal core.

## Structural shell boundary

`shell/shell.ts` deliberately avoids importing `pi-coding-agent`, but it encodes a verified Pi runtime ABI:

- `ShellRuntime.session`
- `ShellSession.prompt(text, { streamingBehavior })`
- `ShellSession.subscribe(listener) -> unsubscribe`
- `ShellSession.abort()`
- `ShellSession.isStreaming`
- event shapes for assistant text deltas and tool execution

LSP found 8 `ShellRuntime` references across 4 files (`shell.ts`, the shell barrel, `index.ts`, and shell tests). This boundary is already a useful extraction seam, but it remains Pi-shaped and is not yet an owned, versioned terminal/session contract.

## Tests as corroborating evidence

Tests are not used as the source of truth, but LSP proves active coverage anchors:

- `launchWithSdk`: 26 references in `packages/octocode-agent/tests/sdk-launcher.test.ts`.
- `resolvePiBin`: 3 references in `packages/octocode-agent/tests/launcher.test.ts`.
- `defaultImportExporter`: 2 references in `packages/octocode-pi-extension/tests/export-command.test.ts`.
- `ShellRuntime`: 2 references in `packages/octocode-pi-extension/tests/shell.test.ts`.
- `createOctocodePiExtension`: 5 references in `packages/octocode-pi-extension/tests/factory.test.ts`.

No test suite was executed by this inventory task; executable baseline evidence belongs to the separate Stage 0 baseline task.

## Removal implications

The minimum replacement surface is not “launch an LLM.” It must own or adapt:

1. session creation/persistence/resume plus interactive, print, JSON, and RPC modes;
2. extension lifecycle/event middleware and blocking/transformation semantics;
3. tools, commands, shortcuts, flags, messages, durable entries, providers, and model/thinking controls;
4. context/session/UI contracts, prompt construction inputs, compaction, rehydration, and user-message delivery;
5. settings/auth/resource loading and the HTML export path;
6. terminal primitives now supplied by `pi-tui`, with the OpenTUI route providing behavioral parity;
7. RPC envelope types used by `octocode-agent serve`;
8. a compatibility adapter so Pi extensions remain supportable after the native core becomes primary.

The safest extraction order is to define owned schemas/interfaces around these observed seams, put Pi behind adapters, dual-run/compare observable behavior, then remove SDK/subprocess/deep-import dependencies only after KPI and test gates pass.

## Confidence and unresolved gaps

Confidence is **high** for direct imports, named SDK members, direct `pi.*` invocation counts, event names, structural shell methods, and the cited LSP reference counts at the captured revisions. Confidence is **medium** for “complete behavior” because runtime reflection, dependency-internal behavior, generated/bundled output, external sibling repositories, and configuration/package metadata were intentionally out of scope.

Open gaps:

- The working revision moved during concurrent work; repeat this inventory at the pinned migration baseline.
- LSP call hierarchy excludes dynamic imports and did not expose the `launchWithSdk` production caller; text/AST evidence supplies that edge.
- Pull diagnostics are unsupported by the active TypeScript server; executable typecheck belongs in baseline evidence.
- Direct call counts are syntactic counts, not runtime frequency or distinct feature counts.
- Type declarations include compatibility members not proven to be used; each must be classified used/adapter-only/dead before freezing the owned API.
- `registerTool` is a centralized boundary, so tool-definition cardinality requires a separate catalog/schema inventory.
- Dynamic package behavior, RPC wire compatibility, terminal rendering, and private exporter compatibility require executable contract tests.
- External Pi implementation/source and sibling Octocode repositories were not inspected in this bounded task.

## Structural self-check

- [x] Commit/tree state and concurrent revision change recorded.
- [x] Exact Octocode schema/query shapes recorded.
- [x] Static imports, dynamic imports, SDK/runtime paths, and subprocess fallback recorded.
- [x] Direct Pi calls, events, central interfaces, shell ABI, and TUI APIs recorded.
- [x] LSP definitions/references/callers and limitations recorded.
- [x] Counts include scope and limitations.
- [x] Tests used only as evidence anchors; no test-pass claim made.
- [x] Unresolved gaps and migration implications recorded.
- [x] No canonical-baseline or Stage-completion claim made.
