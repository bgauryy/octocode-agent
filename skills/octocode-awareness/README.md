# Octocode Awareness Skill

This Agent Skill and the `octocode-awareness` CLI ship together in
`@octocodeai/octocode-awareness` (public CLI: `npx @octocodeai/octocode-awareness`).
In this monorepo, edit the skill at `skills/octocode-awareness`; maintainers rebuild
the package after changes, while agent-facing commands still use the public runner.

The skill gives agents always-on workspace awareness: collaboration, memory, locks,
verification, hooks, reflection, and repo context. It runs a Homeostatic Awareness
Loop — sense shared SQLite/hook state, compare with bounded targets, recommend the
smallest guarded correction, re-measure. ("Living system" is a maintenance metaphor,
not autonomy.) Rationale:
[THESIS.md](https://github.com/bgauryy/octocode-agent/blob/main/packages/octocode-awareness/docs/THESIS.md).

`SKILL.md` is the operating lobby and owns the workflow, loop, and reference routing —
read it first. This README covers only install, scripts, and hosts.

## Export agent instructions

The package can emit its maintained instruction fragment without reading or copying
`SKILL.md` from a prompt:

```bash
npx @octocodeai/octocode-awareness instructions export --format prompt
npx @octocodeai/octocode-awareness instructions export --format agents-md
npx @octocodeai/octocode-awareness instructions export --format json
```

Use `prompt` for dynamic system/developer prompt composition. Use `agents-md` for an
`AGENTS.md` block; its stable start/end comments let a host replace the existing
block idempotently. Output goes only to stdout, so the caller retains control over
file writes. The full installed skill supplies progressive detail; this export is
the concise activation, discovery, coordination, and safety contract.

## Initialize

```bash
npx @octocodeai/octocode-awareness config show --compact
npx @octocodeai/octocode-awareness init --compact
```

When configuration is missing, the skill asks all five feature questions together,
creates `~/.octocode/awareness.json` with `config init`, and validates it before use.
Configuration preferences never authorize hook installation.

The host or package manager owns skill installation. Do not reconstruct destination
paths or copy the bundled skill from an agent prompt. `init` owns deterministic
runtime initialization and is safe to repeat.

This package bundles only the Awareness skill; install other workflow skills with
`npx octocode skill --name <skill>` when needed.

Discovery is lazy — reach for an inventory only when the next action needs it:

```bash
npx @octocodeai/octocode-awareness schema commands --compact
npx @octocodeai/octocode-awareness docs list --compact
```

## Scripts

| Script | Purpose |
|---|---|
| `scripts/awareness.mjs` | Bundled CLI/runtime; serves every `schema` contract dynamically. |
| `scripts/hook-runner.mjs` | Shared host lifecycle implementation. |
| `scripts/extract-hook-files.mjs` | Host payload path extraction. |
| `scripts/hooks/*.sh` | Thin lifecycle wrappers. |

These are generated artifacts — do not hand-edit. Maintainers regenerate them from
`src/schema/*.ts` and `bin/*.ts`.

## Hosts

- Claude may run frontmatter hooks while the skill is active.
- Codex/Cursor: preview `npx @octocodeai/octocode-awareness hooks install --host <codex|cursor> --project-dir "$PWD" --dry-run`, ask the user immediately before mutation, install only after an explicit yes, then run `npx @octocodeai/octocode-awareness hooks check --host <codex|cursor> --project-dir "$PWD" --strict`.
- Pi uses native `@octocodeai/pi-extension` events; never run `hooks install --host pi`.
- Normal hooks are silent; only changed peers/briefings and real conflicts surface.

## Verification (monorepo)

```bash
yarn workspace @octocodeai/octocode-awareness build
yarn workspace @octocodeai/octocode-awareness test:quiet
```

Build emits `out/octocode-awareness.js`, then mirrors this skill to package
`out/skills/` and local `.agents/skills/`.
