# Native CLI architecture review — 2026-08-29

Status: **Accepted local review; release remains HOLD**

## Scope and method

This review maps the current native CLI from the executable shim through command
dispatch, runtime composition, model/tool execution, persistence, transports, and
OpenTUI. It compares the built command behavior with the package docs and this RFC.
Search anchors were resolved with Octocode local search and LSP references; live
commands were run against the built artifact. Historical Pi/native production
parity receipts were not rerun and remain historical baselines.

## Runtime map

| Surface | Owner | Review result |
|---|---|---|
| Executable and command dispatch | `bin/octocode-agent.mjs`, `src/cli.ts`, `src/launcher.ts` | One native entrypoint dispatches management, print, JSON, RPC, ACP, and interactive paths. |
| Composition root | `createDefaultNativeRuntime` and `launchNativeAgent` in `src/native-launcher.ts` | LSP resolves production references from the launcher and replacement-session path plus direct test coverage. Interactive OpenTUI loads only after headless dispatch. |
| Runtime and persistence | `@octocodeai/agent-core`, native session/settings adapters | The native host composes the core kernel, transactional settings, durable sessions, durable compaction, policy, extensions, workers, MCP, and model adapters. |
| Model protocols | `src/native-model.ts`, `src/native-openai-responses-model.ts`, `src/native-anthropic-messages-model.ts` | Chat Completions, Responses, and Anthropic Messages share the native runtime boundary. Credentialed real-host coverage remains a release gate. |
| Tools, MCP, Skills, discovery | native catalog/MCP/Skill adapters and shared discovery | Credential-free discovery exposes source, path, status, and effective enablement. External MCP and Skills are disabled by default; supported models are enabled subject to trust. |
| Headless transports | `src/native-transports.ts`, `src/native-acp.ts`, `src/native-signal-scope.ts` | Print, JSON, bounded JSONL RPC, and ACP share runtime lifecycle and bounded signal cleanup. Public event projection protects private context. |
| Terminal | `src/terminal/opentui/` | OpenTUI remains private to the terminal adapter; PTY restoration, resize, signals, and high-volume streaming pass local sensors. |

## Findings

### Resolved P1 — `update core` could not update the bundled runtime core

The package bundles `@octocodeai/agent-core` into the native artifact and lists it
as a development dependency. `updateCommand` in `src/launcher.ts` nevertheless maps
`update core` to a separate global installation of `@octocodeai/agent-core`. That
installation does not replace the core embedded in the installed launcher.

Resolution: the command exposes only the platform target, rejects unsupported
targets before spawning, and updates the launcher plus embedded core together.
`launcher-update-contract.test.ts` freezes the help, rejection, and spawn behavior.

### Resolved P1 — setup and doctor descriptions exceeded their implementation

The built help says setup configures credentials and discovery files. `runSetupFix`
creates managed model/MCP files and Skill directories but does not create a
credential; credential entry belongs to `auth login`. The doctor report checks
runtime identity and whether a supported credential variable exists. It does not
validate endpoints, MCP connectivity, discovery syntax, filesystem permissions,
the packed artifact, or FFI availability.

Resolution: help assigns managed discovery initialization to setup and credential
configuration to auth. Doctor reports runtime, credentials, and managed discovery
independently without network effects. It fails on malformed managed model, MCP,
or Skill sources and names the invalid source.

### Resolved P2 — typo protection could reject valid free-form prompts

The launcher accepts an unknown first token as a prompt, but nearby command names
are rejected by command suggestion before launch. The built command
`octocode-agent model` exits 2 with a suggestion for `models`, even though the
documented top-level form accepts arbitrary prompt text.

Resolution: exact command names dispatch commands; every other top-level token is
prompt text. `launcher-prompt-contract.test.ts` proves `model` reaches the runtime
while exact `models` remains command-dispatched.

## Verification receipt

- Root `yarn verify` passed on the current working tree.
- Native verification passed 623 tests with 27 environment-dependent skips.
- Packed install, no-native-Pi guards, PTY restoration and resize, signal handling,
  performance guard, and lossless 10,000-event streaming passed.
- Built `--help` exited 0.
- Isolated credential-free `doctor --json` returned the expected typed runtime and
  missing-credential checks and exited 1.
- Built `octocode-agent model` reaches prompt execution instead of command rejection;
  exact `models` still dispatches the management command.
- Octocode LSP found 23 references to `createDefaultNativeRuntime` across production
  and tests and confirmed `runUpdate` is dispatched only through the launcher.

## Resolution receipt

- Three isolated regression files failed against the reviewed implementation, then
  passed after the production changes.
- Workspace discovery now uses the deterministic global namespace under
  `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/`, matching runtime loading without repository-local agent files.
- Unsupported and trailing update targets return 2 without invoking the injected
  spawn boundary; root and Pi guidance no longer advertises the removed core target.
- Managed discovery diagnostics remain credential-free and side-effect-free.
- `setup --scope project` inspects project state with or without `--fix`.
- A fresh-context blind review raised four integration gaps; all four were fixed and
  frozen with focused regressions before the final monorepo gate.

## Cutover verdict

The native CLI is correctly wired for local use, the three command-contract
findings are fixed, and its core runtime, session, transport, terminal, discovery,
and security boundaries are exercised. It is not release-complete. Obtain clean
supported-platform, credentialed provider/editor/MCP, real Pi/native conformance,
assistive-technology, canary, observation-window, and rollback evidence before
changing the RFC release decision from HOLD.
