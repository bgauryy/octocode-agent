# Octocode for Pi

A small, focused [Pi](https://pi.dev) extension that turns Pi into a research-driven coding agent. It builds on Pi's own tools, skills, sessions and compaction instead of replacing them.

```bash
pi install npm:@octocodeai/pi-extension
# or try it once
pi -e npm:@octocodeai/pi-extension
```

## What it adds

| Area | What you get |
|------|--------------|
| **File tool** | One `file` tool replaces Pi's `edit` / `write`: batched edit / write / delete queries, each with a reasoning line, running on Pi's own engines (exact-match edits, diffs). A file that changed on disk since it was read must be re-read before it is modified, and `write` will not replace an existing file the agent has not read. Once Octocode MCP is connected, its `localGetFileContent` replaces `read`. |
| **MCP** | Connects MCP servers (stdio or streamable HTTP) and exposes their tools as native Pi tools. Tools are loaded on demand through the `mcp` tool, so the prompt stays small. [Octocode research](https://github.com/bgauryy/octocode) (GitHub code/PR search, repositories, npm packages, local code search, LSP) is built in. |
| **Skills** | Pi loads skills from `~/.agents/skills`, `~/.pi/agent/skills` and the project's `.agents/skills` / `.pi/skills`; Octocode also picks up `~/.claude/skills`, `~/.codex/skills`, `~/.octocode/skills` and `.claude/skills`. Install Octocode skills with `npx octocode skill --add <name>`. |
| **Subagents** | `agent` runs a task in a fresh Pi process and returns its answer; several calls in one turn run in parallel. Profiles: `researcher`, `implementer`, `reviewer`, `browser`. |
| **Web & browser** | `web` fetches a URL as readable text or searches the web (Tavily / Serper / Exa with an API key, DuckDuckGo otherwise). `browser` drives Chrome over CDP: navigate, snapshot with numbered elements, click, type, evaluate, screenshot, console. |
| **askUser** | Multiple-choice questions (1–4 per call) in an inline dialog with a free-text answer on every question. |
| **Prompt** | A short Octocode section appended to Pi's system prompt: investigate before changing, smallest complete change, verify for real, act on reversible choices, ask only when it matters, research routing (overriding Pi's generic bash-for-files rule), and delegation with each profile's description. Subagents get a variant without askUser or delegation. The section is rebuilt only when the set of ready MCP servers changes. |
| **Compaction** | Old, large tool results are trimmed before each model call (in steps, so the prompt cache survives). Compaction summaries use a structured handoff prompt (user intent and verbatim user messages, constraints, work flow, files, errors, verification, decisions and rejected approaches, pending tasks, current work, next step), written by a cheaper small model of the same provider when one fits, with fallback to the session model and then to Pi's default. See [docs/COMPACTION.md](docs/COMPACTION.md). |
| **UI** | Static banner, terminal title, working indicator, MCP status in the footer, `/mcp` and `/octocode` commands. Every tool renders compactly like Pi's built-ins: a one-line call, a short result preview, full output on ctrl+o. `file` shows each change's reasoning under it, with +/- counts and inline diffs. |

## MCP configuration

Servers use the common `mcpServers` format. Files are merged in this order, later files overriding earlier ones per server:

1. built-in `octocode`
2. `~/.octocode/mcp.json`
3. `~/.pi/agent/mcp.json`
4. `<project>/.mcp.json`
5. `<project>/.pi/mcp.json`

```json
{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" } },
    "db": { "command": "npx", "args": ["-y", "my-db-mcp"], "env": { "DB_URL": "${DB_URL}" }, "eager": true },
    "octocode": { "disabled": true }
  }
}
```

`${VAR}` references are expanded from the environment. `"eager": true` activates a server's tools at startup instead of on demand.

Project files (`<project>/.mcp.json`, `<project>/.pi/mcp.json`) can start arbitrary commands, so they load only when Pi trusts the project (`/trust`). The same applies to project subagent profiles (`<project>/.pi/agents`) and `<project>/.claude/skills`. If a server disconnects, its tools are removed; if that server is Octocode, Pi's `read` comes back.

## Subagent profiles

Profiles are Markdown files with frontmatter. Bundled profiles live in `subagents/`; add your own in `~/.pi/agent/agents/` or `<project>/.pi/agents/` (trusted projects only; same name overrides).

```markdown
---
name: migrator
description: Applies a database migration and verifies it
tools: read,edit,write,bash
model: anthropic/claude-sonnet-4-5
---
Instructions for the subagent…
```

`tools` is an allowlist (Pi's `--tools`); `excludeTools` is a denylist (Pi's `--exclude-tools`). The bundled `researcher` and `reviewer` set `excludeTools: file`, so they cannot edit files through the `file` tool.

Subagents start with `--no-session` and this extension only, and cannot spawn further subagents. Their model usage is added to the parent session's totals, and a subagent whose model call fails is reported as a failed tool call.

## Environment

| Variable | Effect |
|----------|--------|
| `TAVILY_API_KEY` / `SERPER_API_KEY` / `EXA_API_KEY` | Web search provider (first one set wins; DuckDuckGo otherwise) |
| `OCTOCODE_CHROME_PORT` | Chrome remote-debugging port to attach to (default `9222`); the browser tool opens (and later closes) its own tab there. A headless Chrome is launched when nothing listens |
| `OCTOCODE_BROWSER_HEADLESS=0` | Show the launched Chrome window |
| `OCTOCODE_COMPACTION_MODEL` | Model for compaction summaries: `provider/id`, or `current` for the session model (default: a cheaper small model of the same provider when one fits) |

## Development

```bash
yarn workspace @octocodeai/pi-extension build      # tsc → dist/
yarn workspace @octocodeai/pi-extension test       # unit + end-to-end (real Pi session, scripted model, stub MCP server)
yarn workspace @octocodeai/pi-extension lint
pi --no-extensions -e packages/octocode-pi-extension/dist/index.js
```

Source map: `src/index.ts` (wiring), `files.ts`, `mcp.ts` + `mcp-config.ts`, `skills.ts`, `subagents.ts`, `web.ts`, `browser.ts` + `browser-cdp.ts`, `ask.ts` + `ask-dialog.ts`, `prompt.ts`, `compaction.ts` + `compaction-summary.ts` + `compaction-prompt.ts`, `ui.ts`.
