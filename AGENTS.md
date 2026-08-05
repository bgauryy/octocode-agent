# AGENTS.md — Octocode Monorepo

Default agent guide for this repo (the agent-focused slice of the Octocode monorepo: harness + coordination + the branded launcher). Package exception: work in `packages/octocode-awareness` also reads [`packages/octocode-awareness/AGENTS.md`](packages/octocode-awareness/AGENTS.md). Internals: each package's `ARCHITECTURE.md` when present.

## Dogfood

This monorepo is the platform. Use what we ship — do not reinvent with host defaults.

| Need | Use | Not |
|---|---|---|
| Local code search / structure / files / content / binary / LSP | Octocode MCP **or** `npx octocode tools …` — all local tools below | bare `find` / `grep` / `rg` / `cat` / `ls` |
| GitHub code, repos, PRs/commits, clone | same — all GitHub tools below | ad-hoc `gh` / raw API (except when Octocode is unavailable) |
| npm lookup | `npmSearch` | ad-hoc registry curls |
| Unified research / OQL | CLI `search` (and `oqlSearch` when `ENABLE_OQL`) | hand-rolled multi-tool scripts |
| Research / review / change flows | `octocode-research` skill | inventing search loops |
| Shared-repo + cross-run memory | Awareness (`attend` / `work` / `memory` / `reflect`) | silent parallel edits |
| After a package change | rebuild → real CLI / MCP / skill path | claim done from compile alone |

If dogfooding hurts, fix or record it — do not silently bypass.

Method: Plan → TDD → `yarn workspace <pkg> test` → `yarn lint` → verify. No backward compat by default — refactor freely; add shims only when asked.

Access: `packages/*/src/`, `tests/`, `docs/` ✅ · `*.json`, `*.config.*`, `Cargo.toml`, `scripts/` ⚠️ ask · `.env*`, `node_modules/`, `dist/`, `out/`, `target/` ❌

## Architecture

```
 AGENT     octocode-agent  ──launches──▶  Pi + @octocodeai/pi-extension (harness)
 HARNESS   @octocodeai/pi-extension  ── bundles ▶ native tools, CLIs, skills, system prompt, Awareness wiring
 COORD     @octocodeai/octocode-awareness  (SQLite, zero npm runtime deps) ── used by ▶ harness + repo skill
 CONFIG    @octocodeai/config  (env/config loader, zero deps) ── consumed/bundled by ▶ harness and skills
 EXTERNAL  (npm, not in this workspace)  @octocodeai/config · @octocodeai/octocode-tools-core · @octocodeai/octocode-engine
                                       @octocodeai/octocode-core · @octocodeai/mcp · octocode-mcp-vscode
```

This repo ships the agent, harness, and coordination layers. The config loader (`@octocodeai/config`), tool-execution brain (`octocode-tools-core`, `octocode-engine`, `octocode-core`), and the MCP / VS-Code interfaces are published from sibling repos and consumed by `@octocodeai/pi-extension` as npm deps. Never duplicate `getOctocodeHome` or `.env` parsing — use `@octocodeai/config`.

## Packages

Three workspace packages (plus one vendored CLI build when present). Prefer each package's `AGENTS.md` / `docs/` over guessing.

| Package | npm name | What it does | Dig deeper |
|---|---|---|---|
| [`packages/octocode-pi-extension`](packages/octocode-pi-extension) | `@octocodeai/pi-extension` | The Pi harness extension. Bundles the native tool set (from the external brain packages), the `octocode` + `octocode-awareness` CLIs, the system prompt, and Awareness wiring; sets `$OCTOCODE_CLI` and `$OCTOCODE_AWARENESS_CLI` at load. This is where the agent gets its tools, skills, and prompt. | [docs index](packages/octocode-pi-extension/docs/README.md) · [TOOLS](packages/octocode-pi-extension/docs/TOOLS.md) · [AWARENESS flow](packages/octocode-pi-extension/docs/AWARENESS_AGENT_FLOW.md) · [REFLECT](packages/octocode-pi-extension/docs/REFLECT.md) · [OVERRIDES](packages/octocode-pi-extension/docs/OVERRIDES.md) |
| [`packages/octocode-awareness`](packages/octocode-awareness) | `@octocodeai/octocode-awareness` | Shared-repo coordination + memory/hooks/reflection (SQLite, zero npm runtime deps). Owns plans/tasks/WORK, file locks, signals, verification, and reflection. Canonical skill source: repo-root `skills/octocode-awareness`. Local build lives in `packages/octocode-awareness/out/`: `out/index.js` (programmatic/library entry) + `out/octocode-awareness.js` (CLI binary). | [AGENTS](packages/octocode-awareness/AGENTS.md) · [docs index](packages/octocode-awareness/docs/README.md) · [HOW_IT_WORKS](packages/octocode-awareness/docs/HOW_IT_WORKS.md) |
| [`packages/octocode-agent`](packages/octocode-agent) | `octocode-agent` | Branded self-working agent CLI — launches Pi with `@octocodeai/pi-extension` as the harness. One command (`octocode-agent`), one update path. | [docs index](packages/octocode-agent/docs/README.md) · [PI_INTEGRATION](packages/octocode-agent/docs/PI_INTEGRATION.md) |

Config: `@octocodeai/config` is external to this checkout. `packages/octocode-pi-extension/src/env.ts` re-exports it for repo-time use; the extension build inlines it into `dist/env.js` and injects `octocode-config.mjs` into skill script directories.

Octocode CLI: this checkout does not vendor the external `octocode` CLI. Wherever `$OCTO` appears below, use `OCTO='npx octocode'` (or a local build of the sibling `octocode` monorepo when you have one). Prefer the Octocode MCP tools for research; use the CLI only for management tasks (`skill`, `lsp-server`, `auth`) and `search`/`tools` introspection.

External (not in this workspace): `@octocodeai/octocode-tools-core` (tool runners / Octokit / security / providers), `@octocodeai/octocode-engine` (Rust/napi: search, minify, AST, LSP, secrets), `@octocodeai/octocode-core` (schemas, tool descriptions, system prompt text), `@octocodeai/mcp` (stdio MCP server), `octocode-mcp-vscode` (VS Code / multi-editor extension). Published from sibling repos, pulled in as npm deps by `@octocodeai/pi-extension`. Never hand-write tool guidance in interface packages.

## Tools

Full field-level reference: run `$OCTO tools <name> --scheme` for exact schemas. Live catalog: `$OCTO tools --json`.

**Always-on (13)** — dogfood these via MCP or local CLI:

| Family | Tools | Role |
|---|---|---|
| GitHub | `ghSearchCode` · `ghGetFileContent` · `ghViewRepoStructure` · `ghSearchRepos` · `ghHistoryResearch` · `ghCloneRepo` | Remote code/path search, file read, tree, repo discovery, PR/commit history, clone (`ENABLE_CLONE` for clone) |
| Package | `npmSearch` | npm package lookup + source repo |
| Local | `localSearchCode` · `localViewStructure` · `localFindFiles` · `localGetFileContent` · `localBinaryInspect` | Text (text/regex/AST), tree, find-by-meta, file read, archives/binaries (`ENABLE_LOCAL=false` disables the family) |
| LSP | `lspGetSemantics` | definition, references, callers/callees, symbols, types, diagnostics, … |

**OQL / unified research**

- CLI: `$OCTO search` (read-only research lanes; see `$OCTO context --compact`)
- Tool: `oqlSearch` when `ENABLE_OQL` is on (targets: code, content, structure, files, semantics, repos, packages, PRs, commits, artifacts, diff, research, graph) — details: `$OCTO search --help`

Evidence: research analyze packets are **candidates** — upgrade with `target:graph` + `proof:"lsp"` before delete claims. Do not treat `sort:relevance` as proof.

## Build and local run

```bash
yarn build · yarn test · yarn lint · yarn typecheck   # root: fan out to all workspaces
yarn workspace <pkg-name> verify          # per-package (no root `verify`)
```

Native-engine builds, platform checks, and version/pin sync scripts live in the sibling `octocode` monorepo, not here.

Coverage target 90% (Vitest + v8). Rust/engine tests live in the sibling `octocode-engine` repo, not here.

Local end-to-end (when changing a local package):

```bash
yarn workspace @octocodeai/octocode-awareness build
yarn workspace @octocodeai/pi-extension build
yarn workspace octocode-agent build
OCTO='npx octocode'   # no vendored CLI in this checkout
$OCTO --help
$OCTO context --compact
$OCTO tools --json
$OCTO tools localSearchCode lspGetSemantics --scheme
```

After editing a local package, rebuild it (`yarn workspace <pkg> build`) before claiming done.

## Awareness

For non-trivial repo work, activate `octocode-awareness` and run
`node "$OCTOCODE_AWARENESS_CLI" attend --query "<task>" --compact`. This file routes;
the skill owns judgment, the CLI owns live state, and hooks automate lifecycle edges.
Package work also reads [`packages/octocode-awareness/AGENTS.md`](packages/octocode-awareness/AGENTS.md).

Loop: claim a ready task or open WORK; declare edited paths; use `--exclusive` only for sensitive work; check while present; submit/end → `verify mark` → `verify audit`. Use `memory recall --smart` only when prior learning may change the approach; record only verified reusable outcomes.

SQLite is canonical. `.octocode/` holds authored plan docs and optional query exports; never hand-edit generated files. Exact flags: `schema command <noun> [action]`. Full lifecycle: [`docs/HOW_IT_WORKS.md`](packages/octocode-awareness/docs/HOW_IT_WORKS.md).

Skill source: repo-root `skills/octocode-awareness` (build syncs it into `packages/octocode-awareness/skills/` for publishing); use local build `packages/octocode-awareness/out/octocode-awareness.js` or installed `npx @octocodeai/octocode-awareness`. Rebuild after changes; never edit `.agents/skills/` or `out/skills/`. Generated `scripts/awareness.mjs` comes from `bin/awareness.ts`, uses built-in `node:sqlite`, and stays zero npm runtime deps.

## Docs and references

| Area | Links |
|---|---|
| Agent / Pi | [`packages/octocode-agent/docs/README.md`](packages/octocode-agent/docs/README.md) · [`PI_INTEGRATION.md`](packages/octocode-agent/docs/PI_INTEGRATION.md) · pi-extension [`docs/README.md`](packages/octocode-pi-extension/docs/README.md) · [TOOLS](packages/octocode-pi-extension/docs/TOOLS.md) · [AWARENESS flow](packages/octocode-pi-extension/docs/AWARENESS_AGENT_FLOW.md) · [REFLECT](packages/octocode-pi-extension/docs/REFLECT.md) · [OVERRIDES](packages/octocode-pi-extension/docs/OVERRIDES.md) |
| Awareness | [`packages/octocode-awareness/docs/README.md`](packages/octocode-awareness/docs/README.md) — [HOW_IT_WORKS](packages/octocode-awareness/docs/HOW_IT_WORKS.md) · [HOOKS](packages/octocode-awareness/docs/HOOKS.md) · [VERIFY](packages/octocode-awareness/docs/VERIFY.md) · [LOCKS](packages/octocode-awareness/docs/LOCKS.md) · [MEMORY_NAVIGATION](packages/octocode-awareness/docs/MEMORY_NAVIGATION.md) · [WIKI](packages/octocode-awareness/docs/WIKI.md) · [REFERENCES](packages/octocode-awareness/docs/REFERENCES.md) |
| Skills | Repo skill source: [`skills/octocode-awareness`](skills/octocode-awareness) (synced into `packages/octocode-awareness/skills/` at build). Other Octocode skills (research, brainstorming, eval, prompt-optimizer, rfc-generator, roast, skills, subagent) are installed via `node $OCTOCODE_CLI skill --add`. |

No root `docs/` shelf is maintained in this slice. Keep durable docs package-local (`packages/*/docs`) or under Awareness docs; command inventories belong to `package.json`, binary help, and `$OCTO tools --json/--scheme`. Global docs (`OCTOCODE_MCP`, `CONFIGURATION`, `SECURITY`, `OCTOCODE_TOOLS`, `OCTOCODE_CLI`, `OQL_*`) and `release/RELEASE_GUIDE.md` live in the sibling `octocode` monorepo, not this repo. Run `$OCTO context` for the live agent protocol + tool playbook.

## Config / env — single source

All env/config loading flows through `@octocodeai/config`. Never reimplement:

- `getOctocodeHome(env?)` — `OCTOCODE_HOME` → platform default
- `propagateOctocodeEnv({ cwd, trusted, env })` — global + project `.env` → `process.env`
- `parseEnv(text)` · `loadOctocoderc(home?)` · `PROTECTED_KEYS`

Skills: `./octocode-config.mjs` (injected at build). Packages: `import { … } from '@octocodeai/config'` or the package-local re-export when one exists.
