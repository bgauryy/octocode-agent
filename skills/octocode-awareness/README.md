# Octocode Awareness Skill

This Agent Skill and the `octocode-awareness` CLI ship together in
`@octocodeai/octocode-awareness` (public CLI: `npx @octocodeai/octocode-awareness`).
In this monorepo, edit the skill at `skills/octocode-awareness` and build/run the CLI
from `packages/octocode-awareness`.

The skill gives agents always-on workspace awareness: collaboration, memory, locks,
verification, hooks, reflection, and repo context. It runs a Homeostatic Awareness
Loop — sense shared SQLite/hook state, compare with bounded targets, recommend the
smallest guarded correction, re-measure. ("Living system" is a maintenance metaphor,
not autonomy.) Rationale:
[THESIS.md](https://github.com/bgauryy/octocode-agent/blob/main/packages/octocode-awareness/docs/THESIS.md).

`SKILL.md` is the operating lobby and owns the workflow, loop, and reference routing —
read it first. This README covers only install, scripts, and hosts.

## Install

```bash
npm install --global @octocodeai/octocode-awareness
# preview destinations first:
npx octocode skill --add \
  --path "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness" \
  --platform common --dry-run
# then approve the write:
npx octocode skill --add \
  --path "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness" \
  --platform common --force
```

`common` installs to `~/.agents/skills`; use `claude`, `cursor`, `codex`, or `pi` when
the host does not scan that directory. Verify the bundled runtime with:

```bash
node "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness/scripts/install.mjs" --compact
```

This package bundles only the Awareness skill; install other workflow skills with
`npx octocode skill --name <skill>` when needed.

Discovery is lazy — reach for an inventory only when the next action needs it:

```bash
node scripts/awareness.mjs schema commands --compact
node scripts/awareness.mjs docs list --compact
```

## Scripts

| Script | Purpose |
|---|---|
| `scripts/awareness.mjs` | Bundled CLI/runtime; serves every `schema` contract dynamically. |
| `scripts/hook-runner.mjs` | Shared host lifecycle implementation. |
| `scripts/extract-hook-files.mjs` | Host payload path extraction. |
| `scripts/install.mjs` | Runtime check and hook setup guidance. |
| `scripts/smoke-multi-agent.mjs` | Native multi-agent end-to-end smoke. |
| `scripts/hooks/*.sh` | Thin lifecycle wrappers. |

These are generated artifacts — do not hand-edit. Maintainers regenerate them from
`src/schema/*.ts` and `bin/*.ts`.

## Hosts

- Claude may run frontmatter hooks while the skill is active.
- Codex/Cursor: `awareness hooks install`, then `hooks check --strict`.
- Normal hooks are silent; only changed peers/briefings and real conflicts surface.

## Verification (monorepo)

```bash
yarn workspace @octocodeai/octocode-awareness build
yarn workspace @octocodeai/octocode-awareness test:quiet
```

Build emits `out/octocode-awareness.js`, then mirrors this skill to package
`out/skills/` and local `.agents/skills/`.
