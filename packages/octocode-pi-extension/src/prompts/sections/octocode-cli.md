<octocode_cli>
The Octocode CLI is bundled as `$OCTOCODE_CLI`; run with `node $OCTOCODE_CLI <command>`. The Awareness CLI is bundled as `$OCTOCODE_AWARENESS_CLI`; run with `node $OCTOCODE_AWARENESS_CLI <noun> <verb> --compact` and follow the `octocode-awareness` skill.

`node $OCTOCODE_CLI` is the bundled equivalent of `npx octocode` — same commands and flags, no separate install. Prefer native Pi tool functions for research; use the CLI for skill management, archive/cache materialization, schema lookup, context/status, and auth commands that the user must run.

**Common CLI uses**
```
bash: node $OCTOCODE_CLI unzip path/to/archive.zip                 # returns localPath for local tools
bash: node $OCTOCODE_CLI cache fetch owner/repo[@branch] [path]    # materialize GitHub content
bash: node $OCTOCODE_CLI cache status | cache clear --all
bash: node $OCTOCODE_CLI skill --list
bash: node $OCTOCODE_CLI skill --name octocode-research --platform pi
bash: node $OCTOCODE_CLI skill --add --path {{path_to_skills_location}} --platform pi
bash: npx octocode skill --name <skill> --platform pi              # published package fallback
bash: node $OCTOCODE_CLI tools <name> --scheme                     # exact schema; never guess fields
bash: node $OCTOCODE_CLI clone owner/repo[/path]
bash: node $OCTOCODE_CLI context
bash: node $OCTOCODE_CLI lsp-server list
bash: node $OCTOCODE_CLI auth login                                # USER ONLY
```

**Skills:** `octocode-research` is the evidence-first workflow (locate → prove → patch → verify). Install once with `npx octocode skill --name octocode-research --platform pi`, then load on demand before non-trivial code research. The same pattern installs `octocode-rfc-generator`, `octocode-brainstorming`, `octocode-eval`, `octocode-skills`, `octocode-roast`, and `octocode-subagent`. Typed subagents auto-discover installed skills in `~/.pi/agent/skills/` and `<cwd>/.agents/skills/`.

**Find paths:** run `/octocode-status` to see exact `bundled CLI:` and `awareness CLI:` paths if env vars are unset.
</octocode_cli>
