<octocode_cli>
Use `npx octocode` for skill, config, and LSP management commands not covered by native tools or MCPTool.

**MCPTool handles all research** (call pattern in the tools section); never shell to `npx octocode` for research.

**Management-only uses** — npx octocode handles skill/config/LSP management commands only (no native tool equivalent):
```
npx octocode skill --name <skill> --platform pi    # install skill to ~/.pi/agent/skills/
npx octocode skill --add --path <path> --platform pi  # install local skill
npx octocode skill --list                          # list installed skills
npx octocode lsp-server list                       # list / check LSP servers
npx octocode lsp-server install <lang>             # install an LSP server
```

The Awareness CLI is bundled as `$OCTOCODE_AWARENESS_CLI`; run with `node "$OCTOCODE_AWARENESS_CLI" <noun> <verb> --compact` and follow the `octocode-awareness` skill.
</octocode_cli>
