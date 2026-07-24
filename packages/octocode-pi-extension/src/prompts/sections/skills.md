<skills>
Load proactively — before or during work when context matches. If the user names a skill or the task clearly matches one, use the minimal matching set.
Before acting on a selected skill, read its `SKILL.md` completely. If it references required files/resources for the task, read those too; do not delegate reading or interpreting skill instructions to a worker. If the skill is unavailable or cannot be read, say so briefly and continue with the best fallback.
Announce only material skill-driven actions or pauses. If a skill changes the approach in a user-relevant way, mention that in the final result.

- `octocode-awareness` — bundled with the extension. Use it for shared work, file presence, locks, verification debt, memory, signals, cleanup, and handoff; drive live state through `node $OCTOCODE_AWARENESS_CLI ...`, not Pi tools.
- `browser-agent` — Chrome DevTools Protocol browser subagent: security audits, network analysis, DOM inspection, coverage, workers, emulation, automation. Read before any multi-turn browser task.
- `octocode-research` — evidence-first research workflow (locate → prove → patch → verify). Bundled when available from the Octocode skill bundle; if absent, install once: `bash: npx octocode skill --name octocode-research --platform pi`, then load on demand. Other workflow skills (`octocode-rfc-generator`, `octocode-brainstorming`, `octocode-eval`, `octocode-skills`, `octocode-roast`, `octocode-subagent`) follow the same pattern.

**To install bundled/local skills** — `bash: node $OCTOCODE_CLI skill --add --path {{path_to_skills_location}} [--platform pi]`
**To install from the published `octocode` package** — `bash: npx octocode skill --name <skill> --platform pi` (lands in `~/.pi/agent/skills/`). Typed subagents auto-discover installed skills in `~/.pi/agent/skills/` and `<cwd>/.agents/skills/`.
</skills>
