# Validate a native agent release

Use this runbook to produce release evidence for the packed native launcher. A
skipped target is unsupported; it is never a passing result.

## Run the local mechanical gate

Run `yarn verify` from the repository root on Node 26.4.0 or later. The gate
checks source and test types, ordinary and FFI-enabled tests, all workspace
builds, an isolated packed installation, credential-free discovery, and exact
PTY restoration.

For an isolated native-package change, and again before a native package release,
run:

```bash
yarn workspace octocode-agent verify
```

The package gate performs all of the following checks:

- Type-check production and test sources.
- Run the FFI-enabled suite.
- Build the JavaScript launcher and release Rust services.
- Install the packed tar file and verify its public API and executable.
- Exercise the OpenTUI PTY, command, stream, signal, restoration, and guarded
  performance sensors.

The command sensor launches the built terminal against an isolated model
fixture and verifies `/help`, `/status`, plans, Skills, tools, clearing,
compaction, thinking controls, follow-up messages, image attachment readiness,
multiline paste compaction, and terminal restoration. Its timeout cleanup owns an
isolated process group so failed runs don't leave agent or Rust service processes.

Users run `npx octocode-agent` without setting `NODE_OPTIONS`. The published
launcher enables the OpenTUI FFI requirement before it loads the terminal. The
package's `test:opentui:ffi` script provides the corresponding cross-platform test
wrapper for development; don't infer FFI coverage from a Vitest run that silently
skips OpenTUI files.

The repository gate doesn't invoke the package command sensor directly. Run both
gates for a native package release until the repository manifest includes that
sensor.

The checked-in CI workflow repeats this gate on Linux and macOS. Repository
branch protection must require both jobs before release.

Record each mechanical run with these fields:

| Field | Required value |
|---|---|
| Candidate | Commit and packed-artifact SHA-256. |
| Environment | OS, architecture, libc when applicable, Node version, terminal, and dimensions. |
| Scenario | Stable scenario ID and exact command. |
| Result | `PASS`, `FAIL`, or `UNSUPPORTED`. |
| Lifecycle | Exit code or signal and cleanup count. |
| Terminal | Before-state and after-state hashes. |
| Semantics | Normalized semantic-trace hash and artifact references. |
| Limits | Every exclusion or unsupported capability. |

## Validate supported platforms

Run the same root gate on every platform, architecture, libc, runtime, and
terminal the release promises. Linux and macOS CI results don't approve Windows,
other architectures, or additional terminal implementations. Add a target only
after its packed install, discovery, interaction, Unicode, resize, signal,
shutdown, and restoration scenarios pass.

At release time, recheck the pinned `@opentui/core` package against its official
[platform support](https://opentui.com/packages/opentui-core/) and lifecycle
documentation. Record the resolved version and integrity hash.

## Validate assistive output

Test `octocode-agent --accessible` with each supported terminal and assistive
technology combination. Record the participant's consent, environment versions,
task result, errors, elapsed time, focus changes, announcements, and defects.

The task set must cover sending and following up, inspecting tools and plans,
confirming, selecting, entering single-line and multiline values, recovering
from validation errors, cancelling, resizing, and exiting.

Sensitive input remains fail-closed. OpenTUI's official
[Input documentation](https://opentui.com/docs/components/input/) states that
the component has no password-masking mode. Don't enable a sensitive native
control until the public interaction contract carries sensitivity metadata and
the terminal transport can prove that visual, alternate-output, transcript,
history, and diagnostic paths never expose the value.

## Approve performance thresholds

Capture the guarded OpenTUI performance sensor output on equivalent release
hardware. The current sensor records one first-render duration, aggregate
throughput and frame count for 10,000 streamed events, resize recovery, shutdown,
and sampled process RSS. CI enforces conservative regression ceilings of 1,000 ms
for first render, 2,000 ms for the streamed events, 1,000 ms for resize recovery,
500 ms for shutdown, and 1 GiB sampled RSS. These are catastrophic-regression
guardrails, not latency targets.

The guarded sensor does not measure cold-versus-warm startup or p50/p95 frame
duration. Before release, run a separate canonical benchmark on equivalent
hardware that records those metrics with its sample count, workload, terminal
dimensions, and environment. Tighten either set of thresholds only after
comparing equivalent hardware and workloads.

## Make the release decision

The release record must link the packed artifact, per-target mechanical
receipts, assistive-technology results, approved performance thresholds,
cross-host conformance results, canary window, and prior-native rollback
rehearsal. Mark the decision `GO`, `HOLD`, or `ROLLBACK`, name the approving
owners, and give every difference an owner and disposition.
