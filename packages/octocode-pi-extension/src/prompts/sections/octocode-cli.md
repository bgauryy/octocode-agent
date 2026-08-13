<octocode_cli>
Use `npx octocode` (pin freshness with `npx octocode@latest`) for skill, config, and LSP management commands not covered by native tools or MCPTool.

**MCPTool handles all research** (call pattern in the tools section); never shell to `npx octocode` for research.

**Management-only uses** — npx octocode handles skill/config/LSP management commands only (no native tool equivalent):
```
npx octocode@latest skill --list                        # list bundled + installed skills (shows env readiness)
npx octocode@latest skill --name <skill> --platform pi  # install a bundled skill to ~/.pi/agent/skills/
npx octocode@latest skill --add --path <path> --platform pi  # install a local skill
npx octocode@latest skill check                         # verify installed skills + env
npx octocode@latest lsp-server list                     # list / check LSP servers
npx octocode@latest lsp-server install <lang>           # install an LSP server
npx octocode@latest auth                                # show/manage auth (tokens, providers)
```

**Bundled skills worth installing on demand** (install once with the command above, then load when the task matches):
- `octocode-chrome-devtools` — real Chrome DevTools evidence via CDP: network, console, performance, DOM/CSS, screenshots/PDF, security, cookies/storage, click/fill/search flows, auth-gated live pages, stealth/actionability evals. Load before multi-step browser debugging or live page workflows; pairs with the `chromeDebug` tool and the `browser-agent`.
- `octocode-scraping` — responsible public web extraction: crawl triage, structured data/tables, link/workflow mapping, blocked-page diagnosis, and source-cited answers built from a local corpus under `.octocode/tmp/scrape/`. Use for broad scraping/site maps first, then hand off to `octocode-chrome-devtools` for live actions/auth.
- Others: `octocode-research`, `octocode-brainstorming`, `octocode-graph-eval`, `octocode-rfc-generator`, `octocode-roast`, `octocode-prompt-optimizer`, `octocode-subagent`, `octocode-documentation` (see `skill --list` for the full catalog).

Read a skill's `SKILL.md` before acting on it; install to `--platform pi` so typed subagents auto-discover it in `~/.pi/agent/skills/`.

Awareness is separate: see the `<awareness>` section for its bundled `$OCTOCODE_AWARENESS_CLI` and the `octocode-awareness` skill.
</octocode_cli>
