# MCP and Agent Skills implementation/evaluation receipt — 2026-08-27

Status: accepted implementation evidence for the MCP/Agent Skills workstream. This
receipt does not clear the RFC's provider, approval-UI, hooks/plugins, TUI, session,
real-host parity, or release gates.

## Findings closed

1. The public `octocode-agent skills` command now delegates to the real singular
   `octocode skill` CLI surface.
2. Agent Skills YAML parsing and filesystem discovery primitives are host-neutral in
   `@octocodeai/octocode-shared`; Pi no longer imports its frontmatter parser from
   `pi-coding-agent`, and the regex discovery parser is gone.
3. The parser enforces the Agent Skills naming, parent-directory, description,
   compatibility, metadata, and `allowed-tools` contracts. `allowed-tools` is retained
   as a request hint and never becomes a permission grant.
4. The native runtime registers a progressive `skill` tool using the same SQLite
   enablement precedence as Pi.
5. The native runtime registers `MCPTool` with canonical global/project configuration,
   stdio and Streamable HTTP transports, tools/resources/prompts/completion, Ajv input
   validation, environment/header references, bearer-token references, SQLite
   server/tool enablement, workspace-contained stdio cwd, and secret-free status.
6. Runtime protocol libraries remain declared published dependencies instead of being
   incorrectly inlined into the ESM launcher. The actual built CLI starts successfully.

## Evidence anchors

- `packages/octocode-shared/src/agent-skills.ts`
- `packages/octocode-agent/src/native-skills.ts`
- `packages/octocode-agent/src/native-mcp.ts`
- `packages/octocode-agent/src/native-tools.ts`
- `packages/octocode-pi-extension/src/tools/dynamic-skills.ts`
- `packages/octocode-pi-extension/src/tools/skill-tool.ts`
- `docs/DISCOVERY.md`

## Deterministic verification

- `yarn workspace @octocodeai/octocode-shared test`: 45/45
- `yarn workspace octocode-agent test`: 105/105
- `yarn workspace @octocodeai/pi-extension test`: 1761/1761
- `yarn test`: all workspace suites passed
- `yarn lint && yarn typecheck`: passed
- `yarn build`: passed
- `yarn workspace octocode-agent prepack`: published-dependency and native no-Pi guards passed
- Built `octocode-agent --help`: exit 0
- Built `octocode-agent skills --help`: exit 0 and displayed the real `octocode skill` schema
- Real external Node stdio MCP fixture: describe and call passed
- Held-out MCP judge: secret-free/no-connect status plus resources, read-resource,
  prompts, get-prompt, and completion passed

The graph-eval report is stored at
`.octocode/evals/2026-08-27-mcp-skills-loop-report.md`; its validator returned
`pass score=1`. Primary finding closure moved from 0/5 to 5/5.

## Deliberate boundaries and remaining gates

- Foreign Claude/Cursor/Codex/Gemini/VS Code MCP files remain discovery-only and
  disabled in the retained Pi settings/discovery flow. Native execution reads only
  canonical Octocode definitions; it does not silently activate foreign configuration.
- Native remote OAuth is not enabled. Bearer-token environment references are supported;
  adding browser OAuth requires the still-open native UI/settings and durable approval
  decisions.
- Native MCP sampling and elicitation are not advertised, so servers fail closed instead
  of obtaining implicit model or user-input authority. Pi retains its interactive,
  approval-gated implementations.
- Native connections are scoped to each operation. Pi retains persistent catalogs,
  list-changed watchers, OAuth refresh, and catalog snapshot optimization.

These are explicit host-parity/release leftovers, not regressions in the implemented
native tools/resources/prompts/completion contract. They keep T-05 and cutover status
at HOLD until the owning ADRs and real-host conformance matrix are approved.
