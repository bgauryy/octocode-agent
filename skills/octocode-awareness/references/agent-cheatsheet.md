# Agent Cheat Sheet

Use `<cli>`: local `node packages/octocode-awareness/out/octocode-awareness.js`; installed
`npx @octocodeai/octocode-awareness`; bundled `node scripts/awareness.mjs` only as fallback.
Export `OCTOCODE_AGENT_ID`; use Claude frontmatter or checked host config, never both.

## BEFORE / READ

```bash
<cli> attend --workspace "$PWD" --query "<task>" --agent-id "$OCTOCODE_AGENT_ID" --compact
```

Inspect Ready, Claimed, Verify, FilesUnderWork, Inbox. Follow `next` (Verify → Ready →
owned Claimed → FilesUnderWork → Inbox → evidence). Use `--help`,
`schema command <noun> [action]`, or docs only when the next action needs them.
If prior learning could alter the plan, run `memory recall --query "<task>" --workspace "$PWD" --smart --compact`; re-check ranked leads. SQLite is canonical; confirm live state with `attend`/`query`.

## DURING / DO — Shared Task

```bash
<cli> task claim --task-id <task> --agent-id "$OCTOCODE_AGENT_ID" --compact
# hooks declare paths; without hooks:
<cli> work start --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --file <path> --compact
# run the declared check while claim/presence remains active
<cli> task submit --task-id <task> --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --compact
<cli> verify mark --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --message "passed" --compact
```

## DURING / DO — Standalone WORK

```bash
<cli> work start --agent-id "$OCTOCODE_AGENT_ID" --workspace "$PWD" \
  --file <path> --rationale "<why>" --test-plan "<check>" --compact
# run the declared check while presence remains active
<cli> work end --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --compact
# then verify mark
```

Ordinary peers allowed; `work show --workspace "$PWD" --file <path>` when overlap matters. Sensitive work
adds `--exclusive`; exit `2` = wait/signal/switch. `lock wait/prune` are advanced
recovery commands; re-check presence before retrying.

## AFTER / VERIFY — Always

Run the declared check while presence/locks remain active. Then `task submit` or
`work end`, immediately record the result, and confirm this agent has no debt:

```bash
<cli> verify mark --run-id <run> --agent-id "$OCTOCODE_AGENT_ID" --message "<check result>" --compact
<cli> verify audit --workspace "$PWD" --agent-id "$OCTOCODE_AGENT_ID" --compact
```

## LEARN / CLEAN / PROJECT — Only when due

| Condition | Action |
|---|---|
| Verified outcome is reusable | `reflect record --agent-id "$OCTOCODE_AGENT_ID" --workspace "$PWD" --task "<task>" --outcome worked\|partial\|failed --lesson "<lesson>"`; route remaining work with `--fix-repo`, `--fix-harness`, or `--fix-instructions`. |
| Work remains for another run | Publish a handoff signal or run `session capture` (broadcasts one). |
| Workboard reports cleanup pressure | Prefer `memory archive --memory-id <id> --workspace "$PWD" --dry-run --compact`; run `maintenance digest --workspace "$PWD" --dry-run --compact` and inspect before irreversible prune/forget. |
| File references may be stale | Run `query files --workspace "$PWD" --format table --limit 50`; repair/supersede the owning rows. |
| A human needs bulk inspection | Run `query all --workspace "$PWD" --format html --out .octocode/awareness/index.html`. |
| Instructions caused a wrong turn | Run `reflect developer-review --workspace "$PWD"`; close the same feedback row after the instruction fix is verified. |

SQLite is canonical; use live `attend`/`query`/`memory recall` to read current state.

## Hard ideas

For a risky judgment, run `attend --query <risk>`, then load
`references/self-reflection-dialogue.md`; use `references/homeostatic-loop.md`
(subagent rubber-duck section) only when independent inspection adds value. Agreement is not verification.

## Handoffs

Session handoffs are broadcast `kind=handoff` signals: `signal list` shows them;
resolve with `signal resolve --signal-id <id>` after applying and verifying.
`refinement get --state open` returns repo-fix rows only.

## Token Discipline

Compact `attend` for the next action. Prefer grouped `schema commands`, one exact
`schema command`, targeted `verify audit`/`signal list`/`work show`, and CSV/HTML for
bulk. Add `--full` only when the compact receipt cannot drive the next decision.

## Agents & Docs

```bash
<cli> agent register --agent-id "$OCTOCODE_AGENT_ID" --agent-name "<host>" --workspace "$PWD" --compact
<cli> agent list --workspace "$PWD" --compact
```

Only when the needed reference owner is unknown, discover it lazily with `docs list`
(name/title routing) then `docs show <name>` for one skill reference, and
`docs staleness` to flag drift. None index package `docs/**`.

## Skills (install / update / lint)

This package bundles only the Awareness skill. Use `npx octocode` for other skill install/update/lint and for Octocode research/search operations — gate every write.

```bash
# `common` means ~/.agents/skills; use claude/cursor/codex/pi for a host-specific destination.
npm install --global @octocodeai/octocode-awareness
npx octocode skill --add --path "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness" --platform common --dry-run
# after reviewing destinations and approving the write:
npx octocode skill --add --path "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness" --platform common --force
# Initialize store and smoke the CLI
export OCTOCODE_AGENT_ID="${OCTOCODE_AGENT_ID:-my-agent}"
<cli> maintenance init --compact
<cli> attend --workspace "$PWD" --query "smoke" --agent-id "$OCTOCODE_AGENT_ID" --compact

# Codex/Cursor: preview first, install after approval, then verify host wiring.
<cli> hooks install --host <codex|cursor> --project-dir "$PWD" --dry-run
<cli> hooks install --host <codex|cursor> --project-dir "$PWD" --compact
<cli> hooks check --host <codex|cursor> --project-dir "$PWD" --strict
```

Noncompact dry-run/check exposes settings and runtime-health detail; compact output is only a receipt.
Claude skill frontmatter is already a hook surface; do not also install project settings. Use `--host claude` only when frontmatter is unsupported or disabled.

Install dedicated workflow skills separately when the job is skill discovery/install/review; keep using this skill for workspace awareness. Do not install `octocode-awareness` by registry name: the `@octocodeai/octocode-awareness` package already bundles the canonical skill.

## Code Search (not bundled here)

```bash
npx octocode search <dir> --tree --max-depth 2 --no-color
npx octocode search "<term>" <path> --no-color
npx octocode search <file> --content-view exact --no-color
```

Use `npx octocode` so the platform-native engine resolves correctly. Details: `references/octocode.md`. Files: `references/files-awareness.md`.
