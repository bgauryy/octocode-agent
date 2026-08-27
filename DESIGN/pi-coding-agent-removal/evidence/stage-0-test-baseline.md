# Stage 0 executable baseline and conformance receipt

Status: **working-copy evidence; not a canonical migration baseline**  
Captured: `2026-08-27T11:47:25Z`  
Task: `task_ed4b7920a08a45eca8ab8145` in plan `plan_4eddec41599f470ba5a5e292`

This receipt executes the focused baseline seams named by `TEST_PLAN.md`, `KPI.md`, and `PREREQUISITES.md`. It does not establish native-host parity, release readiness, or permission to remove Pi.

## Environment and repository state

| Field | Observed value |
|---|---|
| Repository | `/Users/bgaryy/code/octocode-agent` |
| Commit | `56c572c2c69ce79e1a261d365736ed40ce2fa611` |
| Tracked/untracked status before tests | `git status --short` produced no rows |
| Tracked/untracked status after tests | `git status --porcelain=v1 --untracked-files=all` produced no rows; `git diff --stat` produced no rows |
| RFC visibility | `.gitignore:7:.octocode` ignores this RFC and this receipt; clean porcelain output therefore does not prove these artifacts are committed |
| Node | `v26.4.0` |
| Yarn | `4.9.1` |
| Vitest | `4.1.11` as reported by every focused run |
| OS | Darwin kernel `25.5.0`, arm64 (`RELEASE_ARM64_T6020`) |
| Terminal | `TERM=dumb`; `COLORTERM` empty; `CI` empty |
| Pi package | `@earendil-works/pi-coding-agent@0.84.2`, resolved through `octocode-agent@workspace:packages/octocode-agent` |
| OpenTUI package | `yarn why @opentui/core` returned exit 0 with no dependency rows; no installed workspace dependency was demonstrated |
| Network | Not required by these deterministic/local tests; availability was not measured |

The tracked worktree was clean at both observations, but this is still a working-copy receipt rather than the canonical `before-<commit>.md` required by `PREREQUISITES.md`. It did not run from a separately provisioned clean checkout, does not capture the complete baseline schema, and lives in an ignored directory.

## Executed commands and results

All commands ran from `/Users/bgaryy/code/octocode-agent`. Wall time is `/usr/bin/time -p real`; Vitest duration is the runner-reported duration. Each wrapper printed and returned the tested command's exit code.

| # | Exact tested command | Exit | Files | Tests | Failed | Skipped | Vitest duration | Wall time |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | `yarn workspace @octocodeai/agent-testing test` | 0 | 1 passed | 12 passed | 0 | 0 | 160 ms | 0.94 s |
| 2 | `yarn workspace @octocodeai/pi-extension vitest run tests/mock-pi-host-flow.test.ts` | 0 | 1 passed | 1 passed | 0 | 0 | 2.40 s | 2.91 s |
| 3 | `yarn workspace @octocodeai/pi-extension vitest run tests/mcp-html.test.ts` | 0 | 1 passed | 5 passed | 0 | 0 | 1.20 s | 1.71 s |
| 4 | `yarn workspace octocode-agent vitest run tests/settings.test.ts tests/p3.test.ts` | 0 | 2 passed | 20 passed | 0 | 0 | 1.53 s | 2.04 s |
| 5 | `yarn workspace @octocodeai/pi-extension vitest run tests/runtime-renderer.test.ts` | 0 | 1 passed | 4 passed | 0 | 0 | 121 ms | 0.65 s |
| 6 | `yarn workspace @octocodeai/pi-extension vitest run tests/pi-api-types.test.ts tests/tui-flow-contract.test.ts tests/shell.test.ts tests/session-runtime.test.ts` | 0 | 4 passed | 21 passed | 0 | 0 | 462 ms | 0.97 s |
| 7 | `yarn workspace octocode-agent vitest run tests/launcher.test.ts tests/sdk-launcher.test.ts` | 0 | 2 passed | 159 passed | 0 | 0 | 1.73 s | 2.22 s |
| **Total** | Seven focused invocations | **all 0** | **12 passed** | **222 passed** | **0** | **0** | Not additive across parallelized test files | **11.44 s** |

The launcher settings run emitted interactive picker ANSI control sequences despite `TERM=dumb`; assertions passed and no protocol-purity claim is inferred from that focused unit run.

## What this proves

- The reusable deterministic Pi flow harness passes its 12 current scenarios, including tool lifecycle/update capture, scripted UI/browser operations, session restart/fork/tree behavior, failure paths, cancellation, and isolated-store cleanup.
- The complete extension activates on the reusable mock Pi host, registers representative tools and commands, exposes lifecycle handlers, processes start/before-agent events, and restarts the mocked session.
- The current `settings.html` renderer passes five focused tests for the extension control-center surface and redaction seam.
- Current launcher setting/default-model persistence and validation pass 20 focused tests across `settings.test.ts` and `p3.test.ts`.
- The current Pi runtime renderer passes four tests for status/activity projection and cleanup. This is evidence for the existing renderer seam, not an OpenTUI implementation.
- Directly coupled Pi API types, TUI-flow contract, shell, session runtime, subprocess launcher, and SDK launcher tests pass in the observed workspace.

## What this does not prove

- No `packages/octocode-agent-core/` native implementation or native host exists yet, so no Pi-versus-native conformance comparison ran.
- No `@opentui/core` dependency or native renderer was demonstrated. There were no real PTY, keyboard, resize, focus, accessibility, terminal-restoration, platform matrix, or noninteractive-output checks.
- The settings run did not prove the proposed canonical registry, Models/`models.json` HTML section, browser accessibility, CSP/origin/token behavior, optimistic revisions, atomic writes, rollback, or native/Pi parity.
- The mock-host flow is one structural lifecycle scenario on one resolved Pi version. It is not the required supported-Pi-version matrix and does not cover every event, command, tool, session, compaction, JSON, RPC, print, or security scenario.
- No Codex-format hooks or event-driven plugin fixture corpus was run; trust review, capability grants, transactional activation/unload, resource cleanup, and event parity remain unverified.
- No live-provider, interactive SDK, print, JSON, RPC, session migration, compaction fault, cancellation-race, security, performance, reliability, package-build, root typecheck, root lint, coverage, or release-platform matrix ran.
- Test fixtures were not hashed, raw versus normalized fixture storage was not audited, prompt/tool/command inventories were not captured, and no semantic divergence report was generated.
- No test was intentionally skipped by Vitest in these invocations, but suites outside the explicit focused command set were not selected and must not be described as skipped tests.
- The advanced Awareness store could not initialize because its canonical foreign-key check reported one invalid row at `/Users/bgaryy/.octocode/memory/awareness.sqlite3`. Shared coordination remained operational; the integrity issue was reported to the orchestrator and was not repaired as part of this task.

## Fixture and acceptance gaps for the next Stage 0 work

1. Produce the canonical `before-<commit>.md` receipt from an approved clean checkout and include all fields required by `PREREQUISITES.md`.
2. Freeze and hash normalized lifecycle/RPC traces, prompt snapshots, command inventory, active-tool inventory, and representative redacted Pi sessions.
3. Establish a supported Pi-version activation/conformance matrix rather than relying on the single installed `0.84.2` resolution.
4. Add deterministic print, JSON, RPC, interactive, session, compaction, cancellation, trust, approval, peer-lock, and fault-injection fixtures.
5. Freeze dated Codex hooks JSON/TOML/plugin fixtures and plugin contribution/activation fixtures.
6. Complete the OpenTUI runtime/package spike and real renderer/PTY gates before interpreting the four current renderer tests as terminal-core readiness.
7. Repair and revalidate the advanced Awareness database through its supported maintenance/recovery path; do not hand-edit SQLite state.

## Result

**Focused executable baseline: PASS. Canonical Stage 0 baseline: PENDING.**

The seven selected invocations produced 12 passing files and 222 passing tests with zero failures and zero runner-reported skips. This satisfies the bounded task's executable receipt requirement while preserving the RFC's broader blockers and verification debt.
