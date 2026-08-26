# Octocode Operations

Use this when Awareness needs code, GitHub, package, history, artifact, graph, or skill evidence. Awareness owns coordination/memory; `npx octocode` or Octocode MCP owns research and skill management. No Octocode binary is bundled in this skill. Prefer connected Octocode MCP tools; otherwise run the published CLI so the correct native engine resolves for the host:

Inspect the live catalog before constructing requests:

```bash
npx octocode tools --json
npx octocode tools localViewStructure localSearchCode localGetFileContent lspGetSemantics --scheme
```

## Research Recipes

```bash
# Exact JSON fields come from --scheme; local paths must be absolute.
npx octocode tools localViewStructure --queries '{"path":"/absolute/workspace","maxDepth":2}'
npx octocode tools localSearchCode --queries '{"path":"/absolute/workspace","searchText":"term","mode":"discovery"}'
npx octocode tools localGetFileContent --queries '{"path":"/absolute/workspace/README.md","minify":"symbols"}'

# Remote/package contracts
npx octocode tools ghSearchCode ghSearchRepos ghSearchPullRequests ghSearchCommits npmSearch --scheme
```

Treat hits as leads. Cite paths/lines/IDs in locks, signals, memories, and refinements. Zero matches require one scope/mode/spelling adjustment before an absence claim. Install a dedicated research workflow skill separately for deeper evidence workflows.

## Skill Management

For copy-pasteable install and refresh commands, load `references/agent-cheatsheet.md`; it owns package-path and host-platform setup. Gate skill installation as a write. Return research evidence to Awareness only when it informs a claim, decision, memory, signal, refinement, or verified reflection.
