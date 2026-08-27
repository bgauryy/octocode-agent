# Stage 0 owner and canonical-baseline approval packet

Status: **HOLD — decision packet only**  
Prepared: 2026-08-27 (Asia/Jerusalem)  
Awareness task: `task_905a6f2169bb4aac927ee5c7` in plan `plan_4eddec41599f470ba5a5e292`

This packet turns the remaining Stage 0 entry decisions into explicit approval questions. It does not approve a commit, assign a real person, close a blocker, establish the canonical `before-<commit>.md`, or authorize production changes. `STATUS.md` remains the progress ledger; `PREREQUISITES.md`, `STEPS.md`, `MIGRATION_STAGES.md`, `TEST_PLAN.md`, and `KPI.md` retain their owning requirements.

## Decision summary

| Decision | Current recommendation | Current state | Consequence while unanswered |
|---|---|---|---|
| Canonical before commit | Review `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` as the candidate; approve only after confirming it is the intended product state | Unapproved | B-01 remains open; no canonical baseline or comparison may be claimed |
| Scope and package boundary | Own host-neutral contracts in `packages/octocode-agent-core/`; retain `@octocodeai/pi-extension` as the supported Pi adapter | Defined by the RFC, not accepted here | Step 0 cannot close if either boundary is disputed |
| Required owners | Supply accountable human names/handles for every role in this packet | Unassigned | B-02 remains open; Step 0 stops |
| Clean-checkout policy | Execute the canonical capture in a separate detached checkout of the approved SHA | Proposed | Working-tree evidence remains non-canonical |
| Ignored RFC/evidence policy | Keep execution isolated; publish a redacted content-addressed evidence bundle and record its digest. Any decision to track `.octocode/` requires a separate repository-policy change | Proposed | Local ignored receipts cannot by themselves prove review, persistence, or provenance |
| Privacy and fixtures | Synthetic data first; irreversible redaction before RFC publication; hash raw and normalized artifacts separately | Proposed | Session, hook, plugin, settings, and model fixtures cannot be accepted |
| Migration gate | **HOLD** | Required | No Stage 1 or dependency-removal work may begin |

## Candidate commit and tree facts

These are observations, not an approval or a canonical-baseline receipt.

| Field | Observation |
|---|---|
| Candidate SHA | `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` |
| Branch at inspection | `remove-pi` |
| Commit timestamp and subject | `2026-08-27T14:45:37+03:00`; `Merge pull request #9 from bgauryy/update-agent-awareness` |
| Parents | `fb12e452dd27e87600af3ad683e4533d17ac1c33` and `56c572c2c69ce79e1a261d365736ed40ce2fa611` |
| Tracked/untracked status | `git status --porcelain=v1 --untracked-files=all` returned no rows at inspection time |
| Unstaged/staged diff summaries | `git diff --stat` and `git diff --cached --stat` returned no rows |
| RFC visibility | `git check-ignore -v` attributes both the RFC guide and this packet to `.gitignore:7:.octocode`; the clean status therefore excludes this RFC and its evidence |
| Earlier receipt ancestry | `3188378dfdbe0e3ea84557b7f0796102c90feadd`, `56c572c2c69ce79e1a261d365736ed40ce2fa611`, and `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` are ancestors of the inspected HEAD |

Reproduction commands:

```text
git rev-parse HEAD
git branch --show-current
git status --porcelain=v1 --untracked-files=all
git diff --stat
git diff --cached --stat
git check-ignore -v .octocode/rfc/pi-coding-agent-removal/README.md \
  .octocode/rfc/pi-coding-agent-removal/evidence/stage-0-approval-packet.md
git merge-base --is-ancestor <receipt-sha> HEAD
git show -s --format='%H%n%P%n%aI%n%s' HEAD
```

The candidate is attractive because the integrated semantic receipt ends at this SHA and the two earlier receipt SHAs are ancestors. That ancestry does not prove that it is the desired release baseline, that ignored RFC evidence is committed, or that the full baseline command matrix passes. A decision owner must select it explicitly, and the complete capture must be rerun from a separately provisioned checkout.

## Reviewer evidence inventory

| Receipt | Commit scope | What it establishes | Why it is not canonical |
|---|---|---|---|
| `stage-0-semantic-inventory.md` | Began at `56c572c`; ended at `b7a3b42` | Direct imports, 95 scoped `pi.<method>` calls, 19 event names, Pi/LSP surfaces, terminal dependencies, and removal implications | HEAD moved during capture; executable coverage and external dependencies were out of scope |
| `stage-0-test-baseline.md` | `56c572c` | Seven focused commands passed: 12 files and 222 tests, with zero failures or runner-reported skips | Not a separate clean checkout; incomplete matrix; fixtures were not hashed; ignored receipt |
| `opentui-route-working-tree.md` | `3188378` | Isolated macOS arm64 Bun and Node renderer feasibility | No repository adapter/package/PTY/platform proof; explicit HOLD |
| `KPI.md` initial integration receipt | Reconciled at `b7a3b42` | Earlier SHAs are ancestors; focused harness rerun and RFC validations passed | It explicitly preserves HOLD and does not produce `before-<commit>.md` |

Reviewers must treat counts as scoped navigation and identity evidence, not runtime-frequency or completeness proof. The canonical capture must rerun the exact text, structural AST, LSP, dependency, test, mode, security, fixture, and performance work at the approved SHA.

## Required owner map

No real person is assigned by this packet. The approver must replace every `TBD` with an accountable name or stable team handle and record explicit acceptance. A person may hold multiple roles only when the approval records that choice and identifies who independently reviews conflicts in security, test, and release decisions.

| Required role | Assignee | Owns the decision | Required Stage 0 sign-off |
|---|---|---|---|
| RFC/product scope owner | TBD | Goals, non-goals, native ownership boundary, retained Pi-extension support, accepted differences | Accept scope and resolve or defer questions with triggers |
| Runtime/architecture owner | TBD | `octocode-agent-core` boundary, lifecycle/runtime contracts, provider/model loop, runtime route | Accept one-way dependency design and stable/incidental event-field classification |
| Session/data owner | TBD | Session identity, encoding/store choice, import/replay/fork/compaction, backup and corruption policy | Accept fixture corpus, source-hash preservation, and no-in-place-rewrite policy |
| Security/trust owner | TBD | Trust, approval, plan/lock policy, hooks/plugins capabilities, secret handling, redaction | Accept fail-closed policy, privacy protocol, and zero-tolerance negative matrix |
| Extensions/hooks/plugins owner | TBD | Codex-format version, canonical event mapping, Pi adapter, plugin manifests and lifecycle | Accept dated fixture corpus, compatibility declaration, grants, activation, and unload rules |
| Terminal/accessibility owner | TBD | OpenTUI route, input/rendering/restoration, headless isolation, accessibility strategy | Accept runtime/package/platform route and terminal parity gate; current route remains HOLD |
| Settings/models/config owner | TBD | Canonical registry, `settings.html`, `models.json`, provenance, revisions, atomic writes | Accept setting classification, mutation boundary, recovery, and secret-safe projection |
| Transport/protocol owner | TBD | Interactive, print, JSON, RPC schemas, stdout/stderr purity, cancellation | Accept versioned wire fixtures and compatibility policy |
| Testing/conformance owner | TBD | Shared Pi/native scenario corpus, fixture normalization, environment equivalence, coverage | Accept baseline command matrix, sample design, fixture manifest, and skipped-test policy |
| Dependency/package owner | TBD | Package versions, manifests, native assets, packed artifact, supported Pi/OpenTUI matrices | Accept dependency/version policy and artifact inspection requirements |
| Release/canary owner | TBD | Candidate selection, thresholds, cohorts, observation window, proceed/hold/rollback | Approve the baseline SHA and environment matrix; later sign comparison and rollout decisions |
| Rollback operator/owner | TBD | Host-selector rollback, artifact rollback, backups, rehearsal and incident execution | Accept rollback runbook and demonstrate rollback before native default/removal |

Approval of a role means responsibility for the listed decisions; it is not a blanket waiver of owning-document gates. Missing runtime, session, terminal, security, release, or rollback ownership stops Step 0. Missing extensions, settings, transport, testing, or dependency ownership also leaves required Stage 0 evidence without an accountable sign-off and therefore keeps B-02 open.

## Clean-checkout and ignored-RFC protocol

1. The release owner records one full approved SHA; a branch name or moving `HEAD` is insufficient.
2. Create a new detached checkout or worktree from that SHA in a uniquely named temporary path. Do not reuse the development checkout.
3. Before dependency installation or generation, prove `git rev-parse HEAD` equals the approved SHA and both porcelain status and staged/unstaged diff summaries are empty.
4. Record toolchain, operating system, architecture, environment mode, host, installed Pi version, lockfile digest, and supported platform identity before running tests.
5. Write raw outputs to a restricted evidence staging directory outside the checkout. Product commands must not write into or mutate the source checkout except for documented generated outputs, which are classified and checked afterward.
6. Run the complete Stage 0 matrix. Recheck SHA, status, staged/unstaged diffs, and generated paths after every command group. A mutation invalidates the run unless it is declared, reproducible, and separately approved.
7. Build the redacted receipt and fixture manifest from staged evidence. Copy only approved redacted artifacts into this RFC's `evidence/` directory.
8. Because `.octocode/` is ignored, record `git check-ignore -v` in the receipt. Do not describe an ignored receipt as committed or protected by the candidate SHA.
9. Publish the redacted evidence bundle through the approved review channel and record its SHA-256 manifest digest, location, reviewer, and retention rule. If persistence in Git is required, obtain a separate explicit repository-policy decision to unignore or force-add the RFC; this packet does not authorize that change.
10. A reviewer reproduces the manifest digest and spot-checks the baseline from a second clean checkout before signing. Only then may `STATUS.md` link the canonical receipt and change B-01 state.

## Evidence, privacy, redaction, and fixture hashing protocol

### Data classes and storage

| Class | Examples | Rule |
|---|---|---|
| Public | Schemas, synthetic fixtures, command inventories, public package versions | May enter the redacted RFC bundle after review |
| Internal | Repository paths, timing samples, non-secret debug traces | Minimize; normalize machine-specific values; retain only for the approved window |
| Sensitive | User prompts, session content, filenames revealing private work, provider payloads | Use synthetic substitutes; otherwise irreversibly redact before normalization or publication |
| Secret | API keys, tokens, cookies, authorization headers, private environment/config values | Never enter fixtures, DOM snapshots, logs, receipts, diffs, or bundles; abort and rotate if exposed |

Raw sensitive evidence, when unavoidable, stays access-restricted outside the RFC, is never sent to a model or pasted into Awareness messages, and is deleted according to the approved retention schedule after its redacted derivative is reviewed. Redaction uses typed placeholders such as `<SECRET:API_KEY:1>` and `<PRIVATE:SESSION_TEXT:1>` so equality relationships can be tested without retaining values. Review redaction mappings separately; never include the mapping in the published bundle.

### Normalization boundary

Normalize timestamps, random IDs, absolute temporary paths, provider request IDs, and already-redacted secret-bearing fields. Do not normalize event order, error category, tool or command names, session ancestry, policy decisions, token counts, exit codes, schema versions, or causal relationships. Any new normalization rule requires testing/conformance and security approval and a version bump to the normalizer manifest.

### Hash and manifest rules

1. Capture immutable raw bytes before normalization and calculate SHA-256 for every artifact.
2. Redact before any artifact leaves restricted storage; calculate a separate SHA-256 for the redacted raw artifact.
3. Apply the versioned deterministic normalizer to the redacted artifact and calculate a normalized SHA-256.
4. Record relative logical name, media type, byte length, raw restricted hash when policy permits, redacted hash, normalized hash, normalizer version/hash, source command ID, and redaction review state in a canonical sorted manifest.
5. Serialize the manifest deterministically with UTF-8, LF line endings, stable key order, and no timestamps in hash-bearing content; then hash the manifest itself with SHA-256.
6. Never publish a raw hash when its small input domain could allow recovery of a secret. Record `withheld-sensitive` plus the restricted audit reference instead.
7. Compare before/after by normalized hashes, but retain redacted raw hashes to detect accidental normalizer drift. A hash mismatch requires the first semantic divergence, impact, owner decision, and accepted-fixture update.
8. Include exact commands, tool versions, exits, counts, failures, skips, duration, performance samples, and zero-tolerance guardrail results in the receipt required by `TEST_PLAN.md`.

Minimum fixture groups are prompt snapshots; command and active-tool inventories; lifecycle and RPC traces; composed/direct Pi events and decisions; dated Codex JSON/TOML/plugin fixtures; plugin contribution/activation inventory; terminal semantic events; settings/models snapshots; and representative synthetic or irreversibly redacted sessions. Every production-used Pi capability must have a fixture or an explicit invariant before Stage 0 can exit.

## Exact approval questions

Each answer must include `APPROVE`, `REJECT`, or `DEFER`, the accountable approver identity, date, rationale, and any expiry/trigger. Silence and partial answers mean HOLD.

| ID | Approval question | Recommended answer | Safe default | Consequence of rejection or deferral |
|---|---|---|---|---|
| A-01 | Do you accept the RFC scope: native `octocode-agent` moves to Octocode-owned core contracts while `@octocodeai/pi-extension` remains a supported adapter? | APPROVE if this is still the product decision | HOLD | Step 0 stops; revise RFC scope before any implementation |
| A-02 | Do you approve `packages/octocode-agent-core/` as the host-neutral owner with no Pi, OpenTUI, browser, HTML, filesystem, launcher, or transport types crossing its boundary? | APPROVE | HOLD | Stage 1 package creation and contract extraction remain blocked |
| A-03 | Do you select `b7a3b425f555e4a85f0034d6f91a21f5107fe1ac` as the candidate to reproduce and, only after reproduction, the canonical before SHA? | APPROVE only after confirming this is the intended product state | HOLD | B-01 stays open; choose another full SHA and rerun every receipt |
| A-04 | Do you approve the detached clean-checkout protocol and require pre/post SHA, porcelain, diff, dependency, and generated-output checks? | APPROVE | HOLD | Existing working-tree receipts remain informational only |
| A-05 | While `.octocode/` remains ignored, do you approve a content-addressed redacted evidence bundle plus review-channel sign-off as the persistence mechanism? | APPROVE for Stage 0, or explicitly request a separate tracked-RFC policy change | HOLD | No canonical receipt can be claimed from local ignored files alone |
| A-06 | Do you approve synthetic-first fixtures, the four data classes, irreversible publication redaction, restricted raw storage, and an explicit retention/deletion schedule? | APPROVE after naming the security owner and retention window | HOLD | Fixture capture involving sessions, settings, hooks, plugins, or models must not proceed |
| A-07 | Do you approve the normalization boundary and separate SHA-256 raw/redacted/normalized hashes with a deterministic manifest? | APPROVE after testing and security review | HOLD | Before/after comparisons are invalid |
| A-08 | Do you approve the named environment matrix for the canonical Pi baseline, including every supported OS/architecture/mode and a supported Pi-version policy? | DEFER until the release, testing, transport, and dependency owners fill the exact matrix | HOLD | Stage 0 cannot exit; single-machine results remain scoped evidence |
| A-09 | Do you approve the Stage 0 fixture inventory, performance sample sizes, normalization version, and known-failure list? | DEFER until the owners attach exact values and the complete baseline run | HOLD | `before-<commit>.md` cannot receive proceed status |
| A-10 | Do you assign an accountable name/handle to every role in the required owner map and accept the listed decision/sign-off duties? | APPROVE only with every `TBD` replaced | HOLD | B-02 stays open; Step 0 stops |
| A-11 | Do all required owners sign the completed canonical receipt as PROCEED, with no zero-tolerance failure and with every known baseline failure explicitly owned and accepted? | DEFER until the receipt exists | HOLD | Stage 0 remains incomplete and Stage 1 may not begin |

## Required approval record

The eventual accepted record must contain:

```text
Decision packet digest: <sha256>
Canonical before SHA: <full sha>
Evidence bundle location and manifest digest: <location> / <sha256>
Clean-checkout reproduction receipt: <location>
Privacy/redaction policy version and retention window: <value>
Environment/Pi-version matrix: <value>
Normalizer version and digest: <value>
Known baseline failures and owners: <value>
Role assignments: <role -> accountable name/handle>
A-01..A-11 answers: <decision, approver, date, rationale, expiry/trigger>
Final Stage 0 decision: PROCEED | HOLD
```

The final decision cannot be PROCEED while any required role is `TBD`, any answer is missing, the canonical receipt is absent, raw and normalized fixture hashes do not resolve, a used Pi capability lacks coverage, or a zero-tolerance guardrail fails.

## Blocker disposition and next action

| Blocker | State after this packet | Closure evidence required |
|---|---|---|
| B-01 — canonical before commit not selected | **OPEN — HOLD** | Human approval of A-03 through A-09, a reproducible clean-checkout `evidence/before-<commit>.md`, content-addressed fixture manifest, and reviewer sign-off |
| B-02 — required owners not assigned | **OPEN — HOLD** | Every required role mapped to an accountable human/team handle, A-10 accepted, and the signed owner receipt linked from `STATUS.md` |

Next action: the orchestrator presents A-01 through A-10 to the decision owner and records the decisions without filling unanswered fields. After owners and the candidate SHA are approved, a separate Stage 0 executor performs the clean-checkout capture. A-11 is answered only after that receipt is independently reviewed. Until then, the migration decision is **HOLD**, Stage 0 is incomplete, Stage 1 must not begin, and Pi dependency removal is prohibited.

## Self-check

- [x] Candidate SHA, branch, parents, ancestry, tracked-tree observations, and ignored-RFC caveat are recorded without approval.
- [x] Every required owner role is mapped to decisions and sign-offs without assigning a real person.
- [x] Clean-checkout, ignored evidence, privacy, redaction, retention, normalization, and hashing rules are explicit.
- [x] Approval questions include recommendation, safe default, and consequence.
- [x] Existing receipts are classified as scoped, non-canonical evidence.
- [x] B-01 and B-02 remain explicitly OPEN and HOLD.
- [x] No production source, configuration, manifest, lockfile, `STATUS.md`, or `PREREQUISITES.md` change is authorized or made by this packet.
