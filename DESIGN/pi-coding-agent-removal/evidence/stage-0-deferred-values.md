# Stage 0 deferred-value proposal

<!-- markdownlint-disable MD013 MD060 -->

Prepared: 2026-08-27 (Asia/Jerusalem)  
Candidate commit: `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac`  
Decision: **PROPOSED VALUES ONLY — HOLD; no gate is accepted by this receipt**

This receipt supplies the exact values deferred by D-11 and D-15 in
`stage-0-approval-record.md`. It is an input to owner review, not an approval,
canonical baseline, platform-support claim, fixture capture, benchmark result,
or Stage 0 exit. Every value below remains proposed until the accountable
owners accept it against a completed, content-addressed baseline receipt and
independent security, testing, and release verification.

## Source constraints

The proposal applies the following owning requirements:

- `TEST_PLAN.md` §Test environments requires every supported platform, all four
  modes, trust states, session states, deterministic models, and Pi/shadow/native
  selection; §Fixture and oracle rules defines the normalization boundary;
  §Performance and reliability tests requires warmups, samples, percentiles,
  maxima, and confidence intervals.
- `PREREQUISITES.md` §Baseline capture protocol requires prompt, registry,
  lifecycle/RPC, Pi-event, Codex hook/plugin, contribution, session, and known
  failure evidence.
- `KPI.md` §Migration corpus adds branch, compaction, interruption, corruption,
  Unicode, large-payload, future-entry, and platform-path cases.
- `OPENTUI_TERMINAL_CORE.md` requires macOS/Linux/Windows architecture coverage,
  libc coverage where applicable, native-asset/package proof, PTY restoration,
  and equivalent performance conditions.
- `stage-0-approval-packet.md` fixes the public/internal/sensitive/secret data
  classes, synthetic-first policy, restricted-raw boundary, three hashes, and
  deterministic manifest rules.
- `stage-0-semantic-inventory.md` identifies 20 Pi APIs, 19 subscribed event
  names, the launcher/SDK/subprocess routes, Pi UI/session surfaces, and the
  current `pi-tui` boundary that the fixtures must cover.

## Proposed environment and platform matrix

### Frozen common inputs

| Input | Exact proposed value | Status |
|---|---|---|
| Candidate | `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac`; tree `35747bfb25656a28895f49b21652c08a34fa5940` | Proposed; candidate selection is approved, canonical status is not |
| Node/Yarn | Node.js `26.4.0`; Yarn `4.9.1` | Proposed matrix pin |
| Pi family | Coherent `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, and `pi-agent-core` at exactly `0.84.2` | Proposed execution pin; initial-version policy is approved, matrix result is not |
| OpenTUI spike | Node.js `26.4.0` ESM with `--experimental-ffi`; `@opentui/core` exactly `0.5.8`; package externalized from esbuild | Spike inputs approved; route/platform result is not |
| Locale/time | `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TZ=UTC`; also run one Unicode/RTL fixture under `LANG=he_IL.UTF-8` where the OS provides it | Proposed |
| Network/model | Offline except immutable install/package verification; deterministic scripted model for equality; no live-provider golden data | Proposed |
| Terminal baseline | Headless plus PTY `TERM=xterm-256color`, `COLORTERM=truecolor`, `120x40`; repeat critical resize/restoration cases at `80x24` and `40x12` | Proposed |
| Browser baseline | HTTP-level headless Chromium resolved by the immutable lock; record its exact executable version, CSP, loopback origin, token state, and page revision | Proposed; no browser version is claimed before capture |
| Modes | Interactive SDK, print, JSON, and raw RPC on every release target | Proposed |
| Trust | Trusted, untrusted, and undecided for deterministic policy fixtures; no project code runs during capture | Proposed |

### Release-target cells

Every row is a required cell, not an assertion that it passes at capture time. OS
patch/build, kernel, CPU model, container/VM image digest, native optional
package, and libc version must be recorded from the immutable runner. A missing
runner or native artifact is a failed cell; it cannot be relabeled unsupported
without a separate product/release scope decision.

| Cell | Exact proposed target | Execution requirement |
|---|---|---|
| P-01 | macOS 26 arm64 | Native machine; canonical reference cell uses observed macOS `26.5.2` build `25F84` |
| P-02 | macOS 15 x64 | Native x64 machine; no Rosetta result may substitute |
| P-03 | Ubuntu 24.04 LTS x64, glibc | Native/VM runner with exact image digest |
| P-04 | Ubuntu 24.04 LTS arm64, glibc | Native arm64/VM runner; no QEMU timing data |
| P-05 | Alpine Linux 3.22 x64, musl | Immutable container plus PTY-capable host |
| P-06 | Alpine Linux 3.22 arm64, musl | Native arm64/VM runner; no QEMU timing data |
| P-07 | Windows Server 2025 x64 | Native/VM runner using PowerShell and ConPTY |
| P-08 | Windows 11 24H2 arm64 | Native arm64/VM runner using PowerShell and ConPTY |

Functional conformance, packaging, native-asset resolution, install, startup,
shutdown, signal/cancellation, terminal restoration, and protocol-purity checks
run on P-01 through P-08. Performance comparisons are valid only within the
same cell and hardware class. P-01 is the reference benchmark cell; P-03 and
P-07 are required corroborating benchmark cells. The other rows run functional
and smoke performance checks but do not pool samples with the reference cells.

## Proposed synthetic-first fixture inventory

The exact minimum corpus is **175 scenario records in 12 groups**. A scenario
record may produce multiple raw/redacted/normalized artifacts; `175` is not an
artifact-file count. Each record has a stable ID, schema version, seed, source
command ID, expected semantic outcome, data class, and raw/redacted/normalized
hash slots. Synthetic content is mandatory unless the security owner records
why a redacted capture is unavoidable.

| Group | IDs | Records | Required scenarios |
|---|---|---:|---|
| Prompt snapshots | `FX-PROMPT-001..012` | 12 | Four modes crossed with trusted, untrusted, and undecided workspaces; deterministic model/context inputs |
| Registries and host API | `FX-REG-001..008` | 8 | Command inventory, active/all tool inventory, shortcuts/flags, message/entry renderers, model/thinking selection, session naming, user-message delivery, and host exec |
| Lifecycle and Pi events | `FX-LIFE-001..025` | 25 | One fixture for each of the 19 subscribed event names plus startup/shutdown, successful text turn, tool turn, cancellation, compaction success, and compaction failure compound traces |
| RPC and noninteractive modes | `FX-RPC-001..010` | 10 | Initialize, prompt, streamed response, tool call/result, extension UI request/response, abort, malformed/unknown operation, print, and JSON protocol purity |
| Policy and decisions | `FX-POLICY-001..012` | 12 | Trust/approval/plan/peer-lock allow and deny paths, pre-cancel, blocked call, unknown operation, duplicate effect, and effect-ID preservation |
| Codex hooks | `FX-HOOK-001..018` | 18 | User/project/managed/plugin sources; JSON and TOML; command/MCP/async handlers; enabled/disabled/review-required; matcher hit/miss; changed hash; unsupported prompt/agent; malformed and unknown event/handler |
| Plugins and contributions | `FX-PLUGIN-001..012` | 12 | Valid activation/unload; rollback after partial activation; conflict; capability denial; tool, command, resource, MCP, setting, prompt, UI, and model contributions; owned-resource cleanup |
| Terminal semantics | `FX-TERM-001..018` | 18 | Ready, text stream, tool progress/result/error, confirm/select/input/editor, keyboard cancel, mouse, resize, Unicode/RTL/wide glyphs, capability fallback, init failure, render failure, crash/signal, and exactly-once restore |
| Settings and models | `FX-SET-001..016` | 16 | Eight-section snapshot; defaults/effective values/provenance; global/workspace mutations; stale revision; invalid cross-field input; atomic fault/recovery; models default/catalog/CRUD/import/diff/conflict; unknown-field preservation; synthetic-secret redaction |
| Sessions and migration | `FX-SESSION-001..020` | 20 | Empty, single-turn, streamed text/thinking/tool/custom entry, named/artifact, multi-branch, fork-before, fork-at, tree navigation, rewind, manual compact, automatic compact, overflow retry, failed retry, post-compact continuation, abort/interrupted write, unknown future entry, malformed/truncated tail, Unicode/large payload, and platform path conventions |
| Launcher/version/package | `FX-PKG-001..008` | 8 | SDK new/resume/in-memory, subprocess fallback, exact `0.84.2` admission, unknown-version rejection, mixed-family rejection, packed-artifact activation and rollback |
| Security and redaction | `FX-SEC-001..016` | 16 | Traversal, symlink escape, origin/token/CSRF, oversized body/collection, malicious model metadata, untrusted write, hook/plugin privilege widening, lifecycle forgery, environment/credential leak, provider/tool injection, RPC version confusion, small-domain raw-hash withholding, redaction equality placeholders, and published-bundle secret scan |
| **Total** |  | **175** | Minimum Stage 0 corpus |

The lifecycle group must preserve event order, error category, command/tool
names, policy decisions, session ancestry, exit codes, schema versions, token
counts, causal relationships, and effect IDs. The inventory is incomplete if a
production-used Pi capability from `stage-0-semantic-inventory.md` has neither a
scenario ID nor an explicit invariant reviewed by testing/conformance.

## Proposed performance sample sizes

Run before and after with the same corpus, cell, hardware class, power profile,
terminal dimensions, and process affinity where available. Execute in
alternating blocks to reduce drift. Report every sample, p50, p95, maximum, and
bootstrap 95% confidence intervals. Never pool unlike platforms, model/network
paths, cold and warm runs, or emulated and native architectures.

| Metric | Warmup | Measured samples per implementation, per benchmark cell | Notes |
|---|---:|---:|---|
| Cold process startup to ready | 0 | 50 | Fresh process and fresh temp home each sample |
| Warm process startup to ready | 10 | 100 | Reused immutable caches; new process each sample |
| Accepted input to first visible event | 10 | 100 | Same scripted stream |
| Accepted input to terminal turn event | 10 | 100 | Same scripted tool/text scenarios, reported separately |
| Session append commit | 20 | 500 | Same canonical event batch and storage medium |
| Import/replay projection | 5 per corpus size | 50 per small, medium, and large corpus | Report the three sizes separately |
| Peak RSS for representative turn | 10 | 50 | Sample peak of isolated processes; do not mix renderer/no-renderer runs |
| OpenTUI renderer start to first frame | 10 | 100 | Identical PTY dimensions and presentation state |
| OpenTUI steady frame duration | 1,000 frames | 10,000 frames across 10 independent runs | Report dropped/coalesced presentation updates separately |
| Resize recovery and shutdown | 10 | 100 each | Include `120x40` to `80x24` to `40x12` and restoration |
| Cancel request to terminal state | 10 | 100 | Success/error/cancel scenarios remain separate |
| Reliability | 0 | 1,000 deterministic scenarios per implementation and benchmark cell | Report exact binomial 95% CI by scenario class; all zero-tolerance failures remain zero |

These are sample-count proposals only. Percentage or absolute regression
thresholds remain deliberately unset until the clean baseline is measured, as
required by `KPI.md`. A run with fewer samples is incomplete, not a smaller
confidence claim.

## Proposed normalizer identity and digest strategy

The proposed identity is `pi-removal-normalizer/1.0.0`. Version `1.0.0` freezes
the existing approved boundary; no executable normalizer or digest exists yet,
so this receipt does **not** invent a digest value.

The implementation proposal is:

1. Keep normalizer source, ordered rule manifest, schema, and golden tests in a
   reviewable content-addressed bundle.
2. Canonicalize the bundle as sorted POSIX relative paths, each encoded as
   `UTF-8(path)`, one NUL byte, unsigned 64-bit big-endian byte length, raw file
   bytes, and one NUL byte. Hash the concatenation with SHA-256.
3. Record the resulting identity as
   `pi-removal-normalizer/1.0.0+sha256:<64-lowercase-hex>` in every fixture row
   and evidence manifest. The completed capture must replace the absent digest
   with the computed value and independently reproduce it.
4. Apply rules only to redacted bytes: timestamps, random IDs, temporary
   absolute paths, provider request IDs, ANSI presentation, terminal dimensions
   in frame-only snapshots, cursor/color state in frame-only snapshots, and
   typed already-redacted placeholders.
5. Reject unknown fields/rules instead of deleting them silently. Never
   normalize event ordering, error classes, commands/tools, policy decisions,
   ancestry, token counts, exit codes, schema versions, causal links, effect
   IDs, or semantic terminal events.
6. Bump patch for a bug fix that cannot change normalized bytes, minor for an
   additive rule or schema field, and major for any existing-output change.
   Minor/major changes require security and testing/conformance approval plus
   before/after re-normalization and first-divergence review.

Raw restricted, redacted raw, and normalized SHA-256 values remain separate.
The manifest uses UTF-8, LF, stable key order, sorted logical names, and no
timestamps in hash-bearing content. A sensitive small-domain raw hash is
`withheld-sensitive`, never published.

## Proposed known-failure list

The proposed accepted known-failure allowlist is **empty**. Stage 0 may not
convert missing coverage, unrun commands, environment bootstrap errors, or a
blocked OpenTUI route into accepted baseline failures. The following observed
items must remain separately classified:

| ID | Observation | Proposed classification and disposition | Owner |
|---|---|---|---|
| KF-01 | Clean checkout initially could not resolve generated workspace package entries | Reproducible bootstrap prerequisite, not an accepted product failure; ordered shared/Awareness/testing/extension/agent builds must pass | Testing/release |
| KF-02 | Targeted `tests/opentui-shell.test.ts` invocation found no file; the claimed prototype is absent | Open blocker/fixture gap, not an xfail; replace with the approved native-adapter fixtures before the affected gate | Terminal/testing |
| KF-03 | Node renderer initialization fails without `--experimental-ffi` | Expected negative route constraint; positive spike must pass with the exact flag | Runtime/terminal |
| KF-04 | Full root, platform, mode, fixture, security, performance, and rollback matrices are not yet run | Verification debt, not a known failure; complete before Stage 0 acceptance | Testing/security/release |
| KF-05 | Advanced Awareness store reports a pre-existing one-row foreign-key integrity failure | Out-of-scope infrastructure issue; exclude from product baseline and do not use it to waive RFC checks | Awareness owner |

If the canonical capture produces a real failure, its proposed acceptance row
must include exact command/scenario, first failure, platform cells, impact,
accountable owner, rationale, expiry date or removal trigger, and reviewer
sign-off. Absent all fields, the result is HOLD.

## Proposed retention and deletion windows

| Data | Exact proposed window | Required terminal action |
|---|---|---|
| Secret material | Zero retention | Abort capture; delete contaminated artifacts immediately; rotate exposed credential; record only the incident reference |
| Redaction mapping | Until redaction review completes, capped at 24 hours from capture | Secure deletion; never enter the published bundle |
| Restricted raw internal/sensitive evidence | Until all three independent reviews complete plus 72 hours, capped at 7 calendar days from capture | Secure deletion with deletion receipt; if review misses day 7, delete and recapture |
| Internal benchmark raw samples | 30 calendar days from capture | Delete after reproducibility review; retain only aggregate/redacted samples allowed below |
| Redacted raw and normalized evidence bundle | Through migration completion or abandonment, then 180 calendar days | Archive manifest/digests and delete bundle after the window unless legal/release policy requires a separately approved extension |
| Public synthetic fixtures, schemas, normalizer source/tests, deterministic manifests, and signed receipts | Repository/release support lifetime | Retain as regression and audit evidence; normal repository retention applies |

Deletion receipts contain logical artifact IDs, deletion time, operator, policy
version, and manifest digest, but no deleted content or secret-recoverable hash.
Any retention extension requires security and release approval before expiry,
names a new deletion date, and cannot extend secret or redaction-mapping storage.

## Acceptance boundary

The owners must separately accept or amend:

1. P-01 through P-08 and the frozen common inputs;
2. all 175 scenario IDs and any explicit invariant substitutions;
3. every performance sample count;
4. the normalizer identity, rule boundary, and reproduced implementation digest;
5. the empty known-failure allowlist and each observation classification; and
6. every retention/deletion window.

Until those decisions, the completed fixture hashes and benchmark data exist,
and independent security/testing/release receipts pass, the canonical baseline
and Stage 0 decision remain **HOLD**.
