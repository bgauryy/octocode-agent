# AGENTS.md — @octocodeai/octocode-awareness

This package dogfoods shared work, verification, memory, hooks, and generated repo
context. `AGENTS.md` routes maintainers; the skill owns operating policy; the CLI
owns live state/contracts; package docs own architecture and feature depth.

## Enter

Activate `octocode-awareness`, export one stable identity, choose the runnable CLI,
then ask live state. Pi: `node "$OCTOCODE_AWARENESS_CLI"`; package dev after build:
`node packages/octocode-awareness/out/octocode-awareness.js`; installed smoke:
`npx @octocodeai/octocode-awareness`. Missing local `out/` means build first.

```bash
export OCTOCODE_AGENT_ID="${OCTOCODE_AGENT_ID:-codex-awareness}"
AWARENESS_CLI="packages/octocode-awareness/out/octocode-awareness.js"
node "$AWARENESS_CLI" attend --workspace "$PWD" --query "<current task>" \
  --agent-id "$OCTOCODE_AGENT_ID" --compact
```

Never put `node ...` inside a shell variable and run it; shells treat that as one
executable. Always follow `attend.next`; use `schema command <noun> [action]` only
for unclear flags. SQLite is canonical. Confirm live work with `attend`/`query`; recall
with `memory recall --smart`. Never hand-edit `.octocode/` except authored plans.

Manual fallback: attend; `work start`; check while present; `work end`; `verify mark`;
`verify audit`. Overlap is advisory; use `--exclusive` only for unsafe/non-mergeable
or sensitive work and never bypass a conflict.

## Package Constraints

- Edit runtime/CLI and Zod contracts in `src/**` and `bin/**`.
- Edit the canonical skill only in repo-root `skills/octocode-awareness/**`; package-local `skills/` is generated.
- Edit package guidance in `README.md` and `docs/**`.
- Never hand-edit `out/**`, `.agents/skills/**`, or generated helpers/schemas under
  `skills/octocode-awareness/scripts/**`.
- `out/**` is the ignored publishable build tree; do not restore `dist/**` or a
  package-local `skills/**` source tree.
- Declare every edited file. Structured-write hooks automate presence when healthy;
  explicit CLI presence remains the fallback.
- Before planning, recall memory only when prior learning could change the approach;
  filter by workspace/artifact/file/label and treat ranked hits as leads to verify.
- Harness changes require user authorization, `OCTOCODE_ALLOW_HARNESS_APPLY=1`,
  and a safe non-main branch.
- Keep one normalized workspace and agent ID. Store no secrets in Awareness rows or
  projections.

After any source or skill edit, rebuild before using the CLI, hooks, smoke scripts,
or mirrors:

```bash
yarn workspace @octocodeai/octocode-awareness build
```

## Verification

Use `docs/VERIFY.md` for the complete quick/installed/host/monorepo/release runbook.
Use TDD and the smallest focused check first. Broaden shared changes before marking
the run verified:

```bash
yarn workspace @octocodeai/octocode-awareness typecheck
yarn workspace @octocodeai/octocode-awareness test:quiet
yarn workspace @octocodeai/octocode-awareness test:smoke
yarn workspace @octocodeai/octocode-awareness pack:check
yarn workspace @octocodeai/octocode-awareness verify
```

Skill changes also require `yarn workspace @octocodeai/octocode-awareness build`
and focused tests. Preserve failed-check evidence. Record only reusable learning.
Executable flow: `docs/SKILLS.md`; hooks: `docs/HOOKS.md`; lifecycle:
`docs/HOW_IT_WORKS.md`; concept owners: `docs/README.md`.
