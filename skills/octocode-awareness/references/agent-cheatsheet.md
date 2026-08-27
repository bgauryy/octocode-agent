# Agent Cheat Sheet

`<cli>` means `npx @octocodeai/octocode-awareness`. This is the only documented runner.
Export `OCTOCODE_AGENT_ID` (Claude frontmatter *or* host config, never both). SQLite is canonical — confirm live state with `attend`/`query`.

## BEFORE / READ

```bash
<cli> attend --workspace "$PWD" --query "<task>" --agent-id "$OCTOCODE_AGENT_ID" --compact
```

Read Ready/Claimed/Verify/FilesUnderWork/Inbox; follow `next` (Verify → Ready → owned Claimed → FilesUnderWork → Inbox → evidence).
If prior learning may change the plan: `memory recall --query "<task>" --workspace "$PWD" --smart --compact`.
If the lifecycle choice is unclear, read `flow-matrix.md` first. Use `--help` / `schema command <noun> [action]` / docs only when the next action needs them; direct nouns use `schema command attend`, not `attend run`.

## DURING / DO — Shared Task

```bash
<cli> task claim --task-id <task> --agent-id "$OCTOCODE_AGENT_ID" --compact
# without hooks, declare paths:
<cli> work start --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --file <path> --compact
# run the check while claim/presence is active, then:
<cli> task submit --task-id <task> --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --compact
<cli> verify mark --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --status SUCCESS --message "passed" --compact
```

## DURING / DO — Standalone WORK

```bash
<cli> work start --agent-id "$OCTOCODE_AGENT_ID" --workspace "$PWD" --file <path> --rationale "<why>" --test-plan "<check>" --compact
<cli> work end --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --compact   # then verify mark
```

Ordinary peers OK; `work show --workspace "$PWD" --file <path>` on overlap. Sensitive work adds `--exclusive` (exit `2` = wait/signal/switch). `lock wait/prune` = advanced recovery; re-check presence before retrying.

## AFTER / VERIFY — Always

Run the check while presence/locks are active → `task submit`/`work end` → record → confirm zero debt:

```bash
<cli> verify mark --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --status SUCCESS --message "<result>" --compact
<cli> verify audit --workspace "$PWD" --agent-id "$OCTOCODE_AGENT_ID" --compact
```

**Verify gate** (`octocode-awareness-verify-gate` follow-up on conclude) — clear by kind:
- **PENDING** (edited, unverified): run the check → `verify mark --run-id <id> --status SUCCESS --message "<result>"` (or `--all-pending`).
- **STALE** (ACTIVE lease expired): `verify mark --run-id <id> --status FAILED --message "<why>"` (cannot be SUCCESS).

Loop-safe: de-dups identical run sets, goes quiet after 3 reminders/session. Run checks via `bash` (no new runs) — don't edit tracked files just to satisfy it. `minAgeMs` graces fresh runs in maintenance audits only; `OCTOCODE_NO_VERIFY_GATE=1` disables it.

## LEARN / CLEAN / PROJECT — Only when due

| Condition | Action |
|---|---|
| Verified reusable outcome | `reflect record --agent-id "$OCTOCODE_AGENT_ID" --workspace "$PWD" --task "<task>" --outcome worked\|partial\|failed --lesson "<lesson>"` (+ `--fix-repo`/`--fix-harness`/`--fix-instructions`) |
| Work remains for another run | Publish a handoff signal or `session capture` (broadcasts one) |
| Cleanup pressure from `attend`/`verify audit` | `maintenance digest --workspace "$PWD" --dry-run --compact` first; apply only after reviewing IDs. It resolves stale handoff broadcasts and marks expired ACTIVE runs `FAILED` with receipts, never `SUCCESS`. Use `memory archive --memory-id <id> --workspace "$PWD" --dry-run --compact` for memory rows. |
| Stale file references | `query files --workspace "$PWD" --format table --limit 50`; repair/supersede rows |
| Human bulk inspection | `query all --workspace "$PWD" --format html --out .octocode/awareness/index.html` |
| Instructions caused a wrong turn | `reflect developer-review --workspace "$PWD"`; close the feedback row after the fix is verified |

Before finishing, always run `verify audit --workspace "$PWD" --agent-id "$OCTOCODE_AGENT_ID" --compact`; if it reports stale ACTIVE runs or handoff/signal pressure, preview `maintenance digest --dry-run` and either apply reviewed cleanup or report the exact remaining blocker.

## Hard ideas / Handoffs

Risky judgment: `attend --query <risk>` then load `references/self-reflection-dialogue.md`; `references/homeostatic-loop.md` (rubber-duck) only when independent inspection adds value. Agreement ≠ verification.
Handoffs = broadcast `kind=handoff` signals: `signal list` shows them; `signal resolve --signal-id <id>` after applying+verifying. `refinement get --state open` = repo-fix rows only.

## Token discipline

Compact `attend` for the next action; grouped `schema commands` or one exact `schema command`; targeted `verify audit`/`signal list`/`work show`; CSV/HTML for bulk. Add `--full` only when a compact receipt can't drive the decision.

## Agents & Docs

```bash
<cli> agent register --agent-id "$OCTOCODE_AGENT_ID" --agent-name "<host>" --workspace "$PWD" --compact
<cli> agent list --workspace "$PWD" --compact
```

Unknown reference owner → `docs list` (routing) → `docs show <name>` → `docs staleness` for drift. None index package `docs/**`.

## Initialize and inspect

The host or package manager owns skill installation. Do not construct destination
paths from the prompt. Use the Awareness CLI for deterministic runtime setup and
the live contract:

```bash
export OCTOCODE_AGENT_ID="${OCTOCODE_AGENT_ID:-my-agent}"
<cli> config show --compact
# If missing: ask every returned question together, wait, then config init with all booleans.
<cli> config validate --compact
<cli> init --compact
<cli> schema commands --all --compact
<cli> coordination schema commands
<cli> attend --workspace "$PWD" --query "smoke" --agent-id "$OCTOCODE_AGENT_ID" --compact
# Codex/Cursor: preview → ask user now → install only after explicit approval → verify
<cli> hooks install --host <codex|cursor> --project-dir "$PWD" --dry-run
<cli> hooks install --host <codex|cursor> --project-dir "$PWD" --compact
<cli> hooks check --host <codex|cursor> --project-dir "$PWD" --strict
```

Noncompact dry-run/check shows settings + runtime health; compact = receipt only. Claude frontmatter is already a hook surface — don't also install project settings (`--host claude` only if frontmatter is unsupported).

## Code search (not bundled here)

```bash
npx octocode tools localViewStructure localSearchCode localGetFileContent lspGetSemantics --scheme
npx octocode tools localViewStructure --queries '{"path":"/absolute/workspace","maxDepth":2}'
npx octocode tools localSearchCode --queries '{"path":"/absolute/workspace","searchText":"term","mode":"discovery"}'
```

Use `npx octocode` for the native engine. Details: `references/octocode.md` · files: `references/files-awareness.md`.
