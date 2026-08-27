# Implementation run receipt: native Octocode runtime candidate

Captured: 2026-08-27 (Asia/Jerusalem)  
Baseline and current `HEAD`: `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac`  
Tree state: unstaged multi-package implementation; not a commit-addressed after candidate  
Decision: **HOLD — implementation exists, but verification and external release gates are incomplete**

## Authority and scope

The RFC decision owner explicitly instructed the orchestrator to execute the complete RFC and to orchestrate subagents. This supersedes the earlier preparation-only limit recorded in `stage-0-approval-record.md` for implementation authority. It does not waive the RFC's evidence-based acceptance, independent verification, canary, platform, observation-window, or rollback requirements.

The implemented product boundary follows the approved scope:

- native `octocode-agent` and `@octocodeai/agent-core` are intended to contain no Pi-family runtime, manifest, or built-artifact dependency;
- `@octocodeai/pi-extension` remains a supported Pi-host adapter and therefore retains its explicit Pi host/TUI relationships;
- removing or deprecating the Pi extension is not part of this run.

## Repository state

`git rev-parse HEAD` returned the baseline candidate SHA above. The final working tree is intentionally unstaged on branch `remove-pi`; no commit was created. Because the implementation is not committed, every result below is a dirty-tree receipt rather than a reproducible release-candidate receipt.

The staged implementation includes these material surfaces:

| Surface | Observed implementation |
|---|---|
| Agent core | New `packages/octocode-agent-core/` package with canonical runtime, lifecycle, tool, command, session, model, RPC, UI, settings, hook, plugin, policy, prompt, scope, and error contracts/implementations. |
| Shared conformance | `packages/octocode-agent-testing/src/host-conformance.ts` and focused host-conformance tests. |
| Native launcher/runtime | Native launcher, model port, session store, settings, print/JSON/RPC transports, and native CLI composition under `packages/octocode-agent/src/`. |
| Native terminal | `packages/octocode-agent/src/terminal/opentui/` with semantic projection and an `@opentui/core` renderer boundary. |
| Native Pi removal | Pi SDK launcher, subprocess server, and their Pi-specific tests removed; native manifest now depends on agent core and OpenTUI, not Pi-family packages. |
| Static guard | `packages/octocode-agent/scripts/check-no-native-pi.mjs` scans native `src`, built `out`, and manifest dependency sections for Pi-family coupling. |
| Supported Pi adapter | New Pi host compatibility, lifecycle, registry, settings, hook-discovery, and plugin adapters in `packages/octocode-pi-extension/src/adapters/`; the extension imports `@octocodeai/agent-core`. |
| Settings HTML | Existing protected extension page extended toward the registry-driven settings surface; full RFC completeness remains unproved. |

## Static evidence

Octocode `localSearchCode` was run against native agent source/manifest/scripts, agent core source/manifest, and Pi-extension source/manifest for `@earendil-works/pi-(coding-agent|tui)`:

- `packages/octocode-agent-core`: zero matches in the searched production source and manifest scope;
- `packages/octocode-agent`: no match in `src`, `package.json`, or `scripts/build.mjs`;
- `packages/octocode-pi-extension`: 29 matches across 16 files, including its exact `0.84.2` host peer/dev dependency, `pi-tui`, Pi-only types/helpers, and comments. These are extension-adapter references and are not evidence of native artifact coupling.

The native guard passed after build. Its checked scope is `packages/octocode-agent/src`, `packages/octocode-agent/out`, and all dependency sections in `packages/octocode-agent/package.json`; it rejects `pi-coding-agent`, Pi-family package identifiers, and the former native Pi resolution environment variables. This supports zero Pi in native code, manifest, and generated JavaScript artifact for the tested dirty tree. It is not a packed-tarball dependency-tree or multi-platform proof.

## Verification observed during this run

The orchestrator reported the following exact workspace commands and outcomes from the shared dirty tree:

| Command | Exit/result |
|---|---|
| `yarn workspace @octocodeai/agent-core verify` | Exit 0: typecheck, 7 test files / 24 tests passed, and build passed. |
| `yarn workspace @octocodeai/agent-testing verify` | Exit 0: typecheck, build, and 2 test files / 22 tests passed; coverage was 96.75% statements, 91.44% branches, 97.45% functions, and 99.37% lines. |
| `yarn workspace octocode-agent typecheck` | Exit 0. |
| `yarn workspace octocode-agent test` | Exit 0: 12 test files / 78 tests passed. |
| `yarn workspace octocode-agent build` | Exit 0: native bundle approximately 1001.3 kB. |
| `yarn workspace octocode-agent check:no-native-pi` | Exit 0: `Native Pi dependency guard passed.` |
| `yarn workspace @octocodeai/pi-extension vitest run tests/pi-host-compatibility.test.ts tests/pi-lifecycle-adapter.test.ts tests/pi-registry-adapters.test.ts tests/mcp-html.test.ts tests/mock-pi-host-flow.test.ts` | Exit 0: 5 files / 15 tests passed. |
| `node packages/octocode-agent/out/octocode-agent.mjs version --json` | Exit 0; reported the native agent-core host. |
| `node packages/octocode-agent/out/octocode-agent.mjs --help` | Initially failed by demanding a model key; after the parser regression test/fix, the focused launcher test, rebuild, and exact smoke passed. |
| `npx octocode --help` | Exit 0. |
| `npx octocode context --compact` | Exit 0. |
| `npx octocode tools --json` | Exit 0. |
| Post-implementation `yarn workspace @octocodeai/agent-testing verify` | Exit 0: typecheck, build, and 2 files / 22 tests passed. Coverage was 96.75% statements, 91.44% branches, 97.45% functions, and 99.37% lines. |
| Root `yarn test` | Final-tree exit 0: agent core 24, agent testing 22, Awareness 956, native agent 78, Pi extension 1,760, and shared 31 tests passed. |
| Root `yarn build && yarn lint && yarn typecheck` | Exit 0 for all workspaces. |
| `npm pack --dry-run --json` in `packages/octocode-agent` | Exit 0: seven packed files, no bundled dependencies, native guard passed during prepack, and historical Pi launcher documents were excluded. |
| Built JSONL RPC `runtime.snapshot` without model credentials | Exit 0 with protocol version 1 and a ready native snapshot; credential validation is deferred until an actual model request. |

The post-implementation harness replaces the single fabricated host scenario with the 14 scenarios in `TEST_PLAN.md`: lifecycle/registries, deterministic turn, streaming tool flow, policy denial, tool failures, cancellation, steering/follow-up, session lifecycle, compaction, UI semantics, transport corpus, persistence restart, Codex hooks, and plugin lifecycle. It provides a reusable required-handler adapter surface for Pi and native hosts, normalized SHA-256 trace and effect comparisons, first-divergence paths, duplicate-effect rejection, and effectful-shadow rejection. The harness unit suite exercises two structural test adapters; production Pi/native adapters still must run this matrix before host parity can pass.

The clean detached baseline root test was already red before implementation: the reported root `yarn test` result was 107 files and 955 tests passed with one Awareness CLI schema test failing by timeout. The final dirty-tree root run is green, including 108 Awareness files and 956 Awareness tests.

Independent verification initially observed Pi-extension regressions and contention timeouts. The deterministic defects were fixed, the focused 7-file / 145-test suite passed, and the final serial root run passed the complete Pi-extension suite: 125 files and 1,760 tests. Package build staging now uses private temporary directories plus a serialization lock; an explicit concurrent two-build probe and the 124-test package suite also passed.

The independent verifier also recorded:

| Command/check | Result |
|---|---|
| `yarn lint` | Exit 0 in 1 minute 54 seconds. |
| Full Pi-extension unit suite | Final serial root run passed: 125 files / 1,760 tests. |
| Initial isolated failing Pi-extension rerun | Failed: 204 of 207 tests passed; `resources_discover` returned `undefined` instead of `{}`, steering input did not explicitly continue, and the plan-UX flow timed out at 15 seconds. |
| Post-fix Pi-extension focused rerun | Exit 0: 7 files / 145 tests passed in 10.22 seconds, covering `package.test`, `mcp-html`, and all five adapter suites; extension typecheck also passed. The resource-discovery, explicit-continue, and settings/hook UI regressions were fixed. |
| Concurrent Pi-extension builds | Exit 0 after private temporary staging and build-lock implementation; package suite passed 124 tests. |
| Serial root `yarn build` | Exit 0. |
| Built CLI help, version JSON, models JSON, and RPC snapshot smokes | Exit 0. RPC snapshot works without credentials; real model work remains credential-gated. |

## What this evidence closes

- The implementation-authority blocker is closed: the RFC decision owner explicitly authorized full RFC implementation work.
- The agent-core-package-absent blocker is closed for this dirty-tree candidate.
- Native source, direct manifest entries, and built-JavaScript Pi-family absence has a passing focused guard for this dirty tree.
- Agent core, the shared harness, the native launcher/runtime surface, and focused Pi adapters have executable unit/type/build evidence.

No other RFC stage is closed merely by the existence of code or focused tests.

## Open gates and stop conditions

The release decision remains HOLD because the current evidence does not establish:

- a clean committed after candidate and content-addressed after/comparison receipts;
- the declared multi-version Pi compatibility artifact matrix beyond the exact supported 0.84.2 adapter checks;
- the complete session corpus, Pi import/replay source-hash proof, branch/fork/tree/compaction matrix, or corruption/fault matrix;
- exact Codex official-schema fixture compatibility, independent plugin/security approval, or leak/effect receipts;
- a complete unified `settings.html` Models/Hooks/Plugins/accessibility/security/browser matrix;
- real interactive PTY, terminal restoration, accessibility, performance, native asset, or every-supported-platform OpenTUI proof;
- live-provider smoke, production canary, rollback rehearsal, approved observation window, adoption threshold, or release-owner signature;
- a green matrix from a clean committed after candidate rather than the verified dirty tree.

Independent review found and the implementation fixed native tool registration with exact live Octocode schemas, policy composition, durable session/settings wiring, resume semantics, streamed transcript aggregation, and OpenAI tool-call history correlation. Remaining gaps include production execution of the 14-scenario matrix against both real hosts, full native hook/plugin activation wiring, complete Models editing, and the RFC-required OpenTUI interaction/input and real PTY/platform matrix. The native packed artifact contains no bundled Pi dependency; Pi-family dependencies remain only at the separately supported Pi-extension boundary.

These are external or integration gates, not evidence that the implemented source surfaces are absent.

## Rollback

No user session migration, canary cohort, published artifact, or production rollout was performed by this run. The working-tree rollback is therefore to discard or revert the implementation change set and rebuild the baseline packages. Because the current tree is shared and dirty, that operation must be performed only from an explicit reviewed diff; this receipt does not authorize a destructive reset. If a later package containing this candidate is published, rollback is release-artifact replacement. Pi session sources must remain read-only; never reverse-convert native data in place. The supported `@octocodeai/pi-extension` stays available independently of native rollback.

## Receipt disposition

This receipt proves substantial RFC implementation and focused verification on one macOS/arm64 dirty tree. It deliberately does not mark multi-platform support, live canary observation, compatibility-window closure, independent release acceptance, or the entire RFC complete.

## RFC documentation validation

| Validation | Result |
|---|---|
| Full RFC-folder Markdown style lint | `node /Users/bgaryy/.octocode/skills/octocode-documentation/scripts/style-lint.mjs /Users/bgaryy/code/octocode-agent/.octocode/rfc/pi-coding-agent-removal` exited 0 for 28 Markdown files with 0 errors, 0 warnings, and 346 informational findings. Five pre-existing warnings were corrected without changing decision state. |
| Document structure inventory | Octocode `localViewStructure` reported 17 top-level RFC documents and 11 evidence documents. |
| Step/status alignment | Octocode `localSearchCode` found all 13 `STEPS.md` headings for Steps 0–12 and 21 numbered tracker rows in `STATUS.md`, corresponding to 8 stages and 13 steps. |
| Evidence linkage | Octocode search found the new receipt referenced from the executive signal, stage tracker, evidence index, and change log in `STATUS.md`. |

No dedicated repository RFC structural validator or evaluator command was found in the checked-in scripts, so this run did not invent a replacement. The earlier evaluator receipt remains historical evidence for the unchanged RFC specification; it does not validate this implementation.
