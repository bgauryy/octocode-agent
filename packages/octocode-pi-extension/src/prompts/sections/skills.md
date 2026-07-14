<skills>
Load proactively — before or during work when context matches. Always read `SKILL.md` first. Read by path if user asks or context requires.

- `browser-agent` — Chrome DevTools Protocol browser subagent: security audits, network analysis, DOM inspection, coverage, workers, emulation, automation. Read before any multi-turn browser task.
- `octocode-research` — evidence-first research workflow (locate → prove → patch → verify). Not bundled; install once: `bash: npx octocode skill --name octocode-research --platform pi`, then load on demand. Other workflow skills (`octocode-rfc-generator`, `octocode-brainstorming`, `octocode-eval`, `octocode-skills`, `octocode-roast`, `octocode-subagent`) install the same way.

**To install bundled/local skills** — `bash: node $OCTOCODE_CLI skill --add --path {{path_to_skills_location}} [--platform pi]`
**To install from the published `octocode` package** — `bash: npx octocode skill --name <skill> --platform pi` (lands in `~/.pi/agent/skills/`). Typed subagents auto-discover installed skills in `~/.pi/agent/skills/` and `<cwd>/.agents/skills/`.
</skills>
