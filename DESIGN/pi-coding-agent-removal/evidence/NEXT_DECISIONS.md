# Next decisions requiring user authority

The RFC decision owner's bounded decision is recorded in `stage-0-approval-record.md`. The following table remains the decision definition; it is no longer an unanswered questionnaire. Final acceptance of deferred values and A-11/Stage 0 remain future authority decisions.

## Recorded disposition

| Decision IDs | Recorded state on 2026-08-27 |
|---|---|
| D-01–D-07 | **APPROVE**, subject to the explicit evidence and retention limits in the approval record |
| D-08 | **APPROVE** — all 12 roles assigned to `Octocode maintainers`; security/testing/release require independent subagent verification |
| D-09–D-10 | **APPROVE SPIKE ONLY** — Node.js 26.4.0, experimental FFI, exact OpenTUI 0.5.8, externalized bundle route |
| D-11 | **APPROVE PREPARATION; DEFER FINAL ACCEPTANCE** of the exact platform/native-asset matrix |
| D-12–D-14 | **APPROVE** |
| D-15 | **APPROVE PREPARATION; DEFER FINAL ACCEPTANCE** of the produced Stage 0 values |

Remaining user-authority decisions are acceptance of the exact retention window, platform/environment matrix, fixture inventory, performance sample sizes, normalizer version/digest, known-failure list, canonical baseline receipt, and later stage gates. Until then the migration decision is **HOLD**.

## Decision definitions

| ID | User-authority choice | Recommended answer | Safe default | Exact consequence |
|---|---|---|---|---|
| D-01 | Accept the product scope: native `octocode-agent` moves to Octocode-owned contracts while `@octocodeai/pi-extension` remains supported. | APPROVE | HOLD | Rejection requires an RFC scope rewrite; deferral stops Step 0 and all implementation. |
| D-02 | Approve `packages/octocode-agent-core/` as the host-neutral owner, with Pi, OpenTUI, browser, HTML, filesystem, launcher, and transport types kept behind adapters. | APPROVE | HOLD | Rejection requires a new package-boundary decision; deferral blocks Stage 1 package creation. |
| D-03 | Select `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` as the candidate SHA to reproduce before it can become the canonical baseline. | APPROVE only if it is the intended product state | HOLD | Rejection requires another full SHA; deferral keeps B-01 open and prevents canonical before/after comparison. |
| D-04 | Require the detached clean-checkout protocol, including pre/post SHA, status, diff, dependency, and generated-output checks. | APPROVE | HOLD | Rejection requires an equally reproducible replacement protocol; deferral leaves every working-tree receipt informational. |
| D-05 | While `.octocode/` is ignored, use a content-addressed redacted evidence bundle and review-channel sign-off instead of claiming local files are committed. | APPROVE for Stage 0, or authorize a separate repository-policy change | HOLD | Rejection requires an approved persistence mechanism; deferral prevents a canonical receipt. |
| D-06 | Approve synthetic-first fixtures, irreversible publication redaction, restricted raw storage, and deletion after a named retention window. | APPROVE with a security owner and retention window | HOLD | Rejection requires a replacement privacy policy; deferral prohibits session, settings, model, hook, and plugin fixture capture. |
| D-07 | Approve separate SHA-256 hashes for restricted raw, redacted, and normalized artifacts plus a deterministic manifest. | APPROVE after testing/security review | HOLD | Rejection requires a comparably auditable scheme; deferral makes before/after comparisons invalid. |
| D-08 | Assign accountable names or stable team handles to all 12 roles in `stage-0-approval-packet.md`, including independent review for security, testing, and release conflicts. | APPROVE only with every role filled | HOLD | Any missing role keeps B-02 open and stops Step 0. |
| D-09 | Authorize a bounded Node.js 26.4.0 ESM OpenTUI spike with `--experimental-ffi` confined to the interactive native process. | APPROVE for the spike only | HOLD | Rejection reopens Bun or another route; deferral keeps B-08 open and forbids manifest or terminal work. |
| D-10 | Pin `@opentui/core@0.5.8` exactly and keep it external to the esbuild bundle for the bounded spike, subject to clean-pack inspection. | APPROVE for the spike only | HOLD | Rejection requires another package/version design; deferral authorizes no manifest change. |
| D-11 | Name the supported OpenTUI OS, architecture, and libc targets and approve managed installed native assets with no untrusted project override. | DEFER until product, release, package, and security owners provide the exact matrix | HOLD | Without an approved matrix and asset policy, no canonical OpenTUI route receipt or production renderer load is allowed. |
| D-12 | Replace the absent OpenTUI prototype with canonical native-adapter fixtures instead of claiming the missing files are preserved. | APPROVE | HOLD | Rejection requires supplying verifiable prototype provenance; deferral blocks the affected Step 2 acceptance item. |
| D-13 | Support only exact tested Pi host versions: begin with `0.84.2`; treat `0.84.3` as a candidate until its full packed-artifact matrix passes; reject unknown versions before contribution registration. | APPROVE | HOLD | Rejection requires another tested-version policy; deferral keeps B-05 open and limits the truthful claim to the observed `0.84.2` graph. |
| D-14 | Require coherent Pi-family versions, explicit admission of every later patch, fail-closed unsupported-version tests, and rollback to the prior artifact/Pi host on compatibility failure. | APPROVE | HOLD | Rejection requires an alternative release and rollback policy; deferral forbids widening the peer range or claiming broader support. |
| D-15 | Let the named owners prepare the exact baseline environment matrix, fixture inventory, performance sample sizes, normalizer version, and known-failure list for a later approval. | APPROVE preparation; defer final acceptance until evidence exists | HOLD | Rejection requires new Stage 0 evidence requirements; deferral leaves Stage 0 incomplete and Stage 1 blocked. |
