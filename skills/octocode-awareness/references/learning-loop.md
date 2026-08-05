# Learning Loop, Bookkeeping & Skill Evolution

Use this for outcomes, failures, developer-review, housekeep, improve loops, and skill evolution.
A loop closes only when its output has an owner, an applied action, fresh verification, and a terminal state.

**Bookkeeping (learning)** turns verified outcomes into routed, durable knowledge.
**Housekeep (cleanup)** removes or supersedes stale locks, signals, terminal refinements, and weak/redundant memories.
`query workboard` is the shared upkeep sensor for both.

## Routes (Bookkeeping — Learn)

| Trigger | Produce | Consume | Close |
|---|---|---|---|
| Reusable outcome | `reflect record --lesson` | later `attend`/`memory recall` | Re-check; supersede/forget when stale. |
| Repo/code fix | `--fix-repo` refinement | `refinement get --state open` | Apply, verify, close with agent and check receipt. |
| Harness gap | `--fix-harness` memory | `reflect export-harness` | Human applies; skill review/tests; re-reflect. |
| Bad instructions | `--fix-instructions` | `reflect developer-review` | Update instructions; mark done; confirm live view. |
| Repeated failure | `--failure-signature`/`--eval-failure-json` | `reflect mine-weakness` | One cluster → one fix → re-reflect same signature. |
| Goal/KPI improve | SET GOAL+KPI → smallest change → measure actual results → accept\|revert | — | Reject: undefined KPI, narrative-only accept, checks not run. |
| Role prompt | `reflect record --duo` | one internal dialogue | Capture synthesis only. |
| Independent challenge | rubber-duck subagent | main revises + next check | Never treat agreement as proof; see `references/homeostatic-loop.md`. |
| Stale docs | `docs staleness` | source owner | Update + regenerate needed projections. |

Terminal recipe: `refinement set --refinement-id <id> --agent-id "$OCTOCODE_AGENT_ID" --state done --check-receipt "<check and result>"`.

## Failures

Capture so errors cluster: `reflect record --outcome failed --failure-signature "<stable key>" --lesson "…"`. Stable key = `test:<name>` or `<class>:<site>`, not the full message. Bulk: `--eval-failure-json '[...]'`. Mine with `reflect mine-weakness`; route `--fix-repo|harness|instructions`; re-reflect with the **same** signature. `--outcome` must be `worked|partial|failed`.

## Developer Review (Fix Instructions)

When human-authored instructions caused time loss, guessing, or a wrong turn — name the source, cost, and proposed replacement; attach instruction files with `--fix-file`; keep one concern per call:

```bash
octocode-awareness reflect record --agent-id "$OCTOCODE_AGENT_ID" \
  --workspace "$PWD" --task "add lock retry" --outcome partial \
  --fix-instructions "AGENTS.md omits the lock TTL; document the limit and extension path." \
  --fix-file AGENTS.md --compact
```

Consume: `reflect developer-review --format markdown` or `query developer-review` JSON. Workboard: `DeveloperReview` column for open feedback. After updating the owning instruction, close with `refinement set --refinement-id <id> --state done --check-receipt "<check and result>"`. Use `--fix-repo` for code behavior, `--fix-harness` for skill/hook machinery.

## Housekeep (Cleanup)

Ops: reversible `memory archive|restore`; reviewed `maintenance digest`, `lock prune`, `signal prune`, `memory forget`, `refinement delete`; automatic salience decay.

Triggers (workboard-driven):
- Workboard shows items → drain memory-review/`stale_file_refs` rows; prune stale locks/signals the board flags.
- Before finishing, only when sensors show pressure → `reflect mine-weakness` if failures repeated; `maintenance digest --dry-run` (reports pressure, prunes only expired/superseded/terminal rows).
- End of session → prune expired/resolved rows only when workboard lists them; dry-run first.
- Idle → `maintenance digest --dry-run`, review IDs, then apply.

Rules: dry-run before any mutation; report evidence before removing. Delete exact synthetic duplicates and expired handoffs; archive weak old memories. Never delete or mark work successful from age alone: stale unproved runs become `FAILED`. Prefer supersession/archive/decay over destructive deletion; restore is valid only for archived rows, not replacement history.

## Durable Output

| Write with | Lands in |
|---|---|
| Verified knowledge, gotchas, lessons, external references | live `query memory`/`memory recall` |
| `--reference file:…`/`--file` paths | live `query files` |
| `--fix-instructions` feedback | live `reflect developer-review`/`query developer-review` |

SQLite is canonical. Use live `attend`/`query`/`memory recall` to read current state.

## Skill Evolution (SkillOpt)

Treat the skill folder as the **trainable external state** of a frozen agent. Accept only edits that improve a held-out check; keep rejected proposals as learning evidence (`reflect record --fix-harness`).

Operator loop: `ATTEND → SET GOAL+KPI → RESEARCH → PLAN (bounded edits) → USER GATE → ACT → REVIEW → VALIDATE → REFLECT`

- **Research**: inspect real `SKILL.md` folders; use `references/self-reflection-dialogue.md` for hard judgment.
- **Improve/update**: READ→PLAN→EDIT→VERIFY; prefer patch-mode (one concept per round); smoke on a task outside the failure that motivated the edit; no write without user approval when skill is shared.
- **Reject path**: revert, record why it hurt (`memory record`/`reflect record --fix-harness`), propose a smaller edit.
- **Ship**: prune orphans; `npx octocode skill --add --path <skill-dir> --platform <host> --force`.

Hard rules:
- Do **not** one-shot regenerate a working skill from a summary — read every behavior-affecting file first.
- Do **not** treat a plausible diagnosis as an accepted edit — held-out validation is mandatory.
- Do **not** dump trajectory logs into `SKILL.md` — procedural rules only; instance detail stays in memory/reflect.

Stop when: one clear path exists; two high-rated candidates → pick one; three research angles add nothing; or a user gate is pending.

## Sequence

```text
VERIFIED OUTCOME -> REFLECT -> ROUTE -> APPLY -> VERIFY -> CLOSE ROW -> PROJECT IF USEFUL -> ATTEND
```

`none` closes when nothing durable remains. `export-harness` is preview-only. Keep memory/refinement IDs until closure. Re-run `attend`/`query` after any action to confirm health.
