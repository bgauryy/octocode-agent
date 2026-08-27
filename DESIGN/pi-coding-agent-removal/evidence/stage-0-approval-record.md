# Stage 0 bounded approval record

Recorded: 2026-08-27 (Asia/Jerusalem)  
Approver: User, acting as the RFC decision owner  
Owner handle: `Octocode maintainers`  
Decision source: The orchestrator presented the exact recommended D-01–D-07, D-09–D-10, and D-12–D-15 batch, with D-11 preparation allowed but final platform acceptance deferred. The RFC decision owner answered `DO ALL`, then instructed the orchestrator to execute the RFC without the Awareness skill.  
Stage decision: **HOLD — bounded preparation is approved; Stage 0 has not exited**

This record captures only the authority granted in the conversation. It does not invent missing environment values, approve a canonical baseline receipt, authorize production rollout, or authorize Pi dependency removal. RFC execution uses ordinary orchestrator/subagent collaboration; Awareness hooks, skills, CLI state, and ledgers are not required by this approval.

## Recorded decisions

| ID | Decision | Disposition | Rationale and limit |
|---|---|---|---|
| D-01 | Native `octocode-agent` moves to Octocode-owned contracts while `@octocodeai/pi-extension` remains supported | **APPROVE** | Accepts the RFC product scope. |
| D-02 | `packages/octocode-agent-core/` owns host-neutral contracts behind adapters | **APPROVE** | Pi, OpenTUI, browser, HTML, filesystem, launcher, and transport types stay outside the core boundary. |
| D-03 | Select `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` as the candidate SHA to reproduce | **APPROVE CANDIDATE** | This selects the candidate only. It becomes canonical only after clean capture and independent sign-off. |
| D-04 | Require detached clean-checkout pre/post integrity checks | **APPROVE** | Canonical evidence must follow the packet protocol. |
| D-05 | Use a content-addressed redacted evidence bundle while `.octocode/` remains ignored | **APPROVE** | This does not authorize changing repository ignore policy. |
| D-06 | Use synthetic-first fixtures, irreversible publication redaction, restricted raw storage, and deletion under an approved retention schedule | **APPROVE POLICY** | The exact retention window remains an output for owner preparation and must be accepted before sensitive capture. |
| D-07 | Use separate restricted-raw, redacted, and normalized SHA-256 hashes plus a deterministic manifest | **APPROVE** | Testing and security reviewers must independently verify the implementation and receipt. |
| D-08 | Assign every required owner role | **APPROVE** | All 12 roles are assigned to `Octocode maintainers`; security, testing, and release decisions require independent subagent verification. |
| D-09 | Run a bounded Node.js 26.4.0 ESM OpenTUI spike with `--experimental-ffi` | **APPROVE SPIKE ONLY** | Authorization is confined to the interactive native-process experiment. |
| D-10 | Pin `@opentui/core@0.5.8` and keep it external to the esbuild bundle for the spike | **APPROVE SPIKE ONLY** | Clean-pack inspection remains mandatory; this is not a production route approval. |
| D-11 | Prepare the supported OpenTUI platform/native-asset matrix | **APPROVE PREPARATION; DEFER FINAL ACCEPTANCE** | No production renderer load or canonical route claim is allowed until the exact matrix and asset policy pass review. |
| D-12 | Replace the absent prototype assumption with canonical native-adapter fixtures | **APPROVE** | Evidence must describe fixtures produced during this implementation, not claim missing prototype preservation. |
| D-13 | Initially support only exact tested Pi host version `0.84.2` | **APPROVE** | `0.84.3` remains a candidate until its complete packed-artifact matrix passes; unknown versions fail before registration. |
| D-14 | Require coherent Pi-family versions, explicit later-patch admission, fail-closed tests, and artifact/host rollback | **APPROVE** | No broader compatibility claim is authorized. |
| D-15 | Prepare the exact baseline matrix, fixture inventory, sample sizes, normalizer version, and known-failure list | **APPROVE PREPARATION; DEFER FINAL ACCEPTANCE** | Owners may prepare these values, but Stage 0 cannot exit until the completed evidence is separately accepted. |

## Owner assignments

All roles are assigned to the stable team handle `Octocode maintainers`:

1. RFC/product scope owner
2. Runtime/architecture owner
3. Session/data owner
4. Security/trust owner
5. Extensions/hooks/plugins owner
6. Terminal/accessibility owner
7. Settings/models/config owner
8. Transport/protocol owner
9. Testing/conformance owner
10. Dependency/package owner
11. Release/canary owner
12. Rollback operator/owner

One team may hold multiple roles, but the security, testing, and release acceptance receipts require independent subagent verification. The implementing subagent cannot be the sole verifier of its own security, test, or release conclusion.

## Mapping to the approval packet

| Packet answer | Recorded state |
|---|---|
| A-01, A-02, A-04, A-05, A-07, A-10 | **APPROVE** |
| A-03 | **APPROVE candidate selection; canonical status pending reproduction and sign-off** |
| A-06 | **APPROVE policy; exact retention window pending** |
| A-08 | **DEFER final acceptance; preparation authorized** |
| A-09 | **DEFER final acceptance; preparation authorized** |
| A-11 | **DEFER until the canonical receipt exists and passes independent review** |

## Blocker effect

| Blocker | State after this approval | Reason |
|---|---|---|
| B-01 — canonical before commit | **OPEN — IN PROGRESS** | The candidate is selected, but clean reproduction, complete evidence, manifest, and independent sign-off do not yet exist. |
| B-02 — required owners | **CLOSED** | All 12 roles are assigned to `Octocode maintainers`, with independent verification required for security, testing, and release. |
| B-05 — supported Pi matrix | **OPEN — IN PROGRESS** | Exact `0.84.2` initial policy is approved; the complete packed-artifact, rejection, and platform matrix remains to be produced. |
| B-08 — OpenTUI route | **OPEN — IN PROGRESS** | The bounded spike is authorized; the platform/native-asset matrix and canonical route receipt remain unapproved. |

All other blockers retain their current state. Pre-Stage 0 remains active. Stage 1, native-default rollout, dependency removal, and production rollout are not authorized.

## Next authorized work

1. Reproduce the selected candidate SHA in a detached clean checkout.
2. Prepare the exact baseline environment, fixture, performance, normalizer, retention, and known-failure values.
3. Produce the bounded OpenTUI spike and platform-matrix evidence without claiming production support.
4. Produce the exact Pi `0.84.2` admission/rejection and coherent-family evidence.
5. Obtain independent security, testing, and release verification before any affected gate is accepted.

The next stage decision remains **HOLD** until the canonical receipt and all required values resolve.
