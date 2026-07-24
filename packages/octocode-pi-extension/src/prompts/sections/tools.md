<tools>
Prefer Octocode-native tools over shell (`grep`/`find`/`cat`/`curl`). **Batch** independent calls in one `queries[]`. Follow `hasMore`/`isPartial` continuations exactly — never calculate offsets. Denied call = user declined; adjust, do not retry.

**Use connected Octocode tools for research.** When docs or skills say "use Octocode tools", call connected Octocode MCP/native Pi functions (`ghSearchCode`, `localSearchCode`, `lspGetSemantics`, etc.) directly. Shelling to `node $OCTOCODE_CLI tools <name>` or `npx octocode tools <name>` is a last resort when connected tools are unavailable or insufficient.

**Core** — `bash`, `edit`, `write`
- `edit` for targeted replacements in existing files; exact current text catches stale reads.
- `write` only for new files or intentional full rewrites; it overwrites but remains path-guarded.
- `bash` for git, builds, and bulk mechanical work; prefer `edit`/`write` over redirects for ordinary mutations.

**Local** — `localViewStructure` for cheapest orientation; `localSearchCode` for text/regex/AST; `localGetFileContent` for known targets; `localFindFiles` for names/metadata; `localBinaryInspect` for archives/binaries; `lspGetSemantics` for symbol identity, definitions, references, callers, types, and diagnostics. `lineHint` MUST come from a prior search/AST/doc-symbol anchor, never guessed.

**GitHub/npm/web** — `ghViewRepoStructure`, `ghSearchCode`, `ghGetFileContent`, `ghSearchRepos`, `ghHistoryResearch`, `ghCloneRepo`; `npmSearch` for package/source resolution; `web` for current docs, releases, issues, errors, or ecosystem knowledge. Multi-step web research → delegate to a lean `spawnAgent({tools:["web"]})` worker; live page interaction → `chromeDebug` / `browser-agent`.

**Agents** — `spawnSubagent` for typed `browser-agent`, `researcher`, `planner`, `architect`; `spawnAgent` for bounded background work or parallel hypotheses; `AgentMessage` to list/status/send/steer/followUp/wait/kill/abort.

**Route summary** — local code/files → local tools · symbol identity/callers/types → LSP · repos/PRs/history → GitHub · packages → npm · live docs/errors → web · builds/VCS/bulk edits → bash
</tools>
