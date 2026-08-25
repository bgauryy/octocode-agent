# AGENTS.md — Octocode Monorepo

Default agent guide for this repo (the agent-focused slice of the Octocode monorepo: harness + coordination + the branded launcher). Package exception: work in `packages/octocode-awareness` also reads [`packages/octocode-awareness/AGENTS.md`](packages/octocode-awareness/AGENTS.md). Internals: each package's `ARCHITECTURE.md` when present.

## Dogfood

This monorepo is the platform. Use what we ship — do not reinvent with host defaults.

| Need | Use | Not |
|---|---|---|
| Local code search / structure / files / content / binary / LSP | Octocode MCP **or** `npx octocode tools …` — all local tools below | bare `find` / `grep` / `rg` / `cat` / `ls` |
| GitHub code, repos, PRs/commits, clone | same — all GitHub tools below | ad-hoc `gh` / raw API (except when Octocode is unavailable) |
| npm lookup | `npmSearch` | ad-hoc registry curls |
| Unified research workflow | `octocode-research` skill + the live tool catalog | hand-rolled multi-tool scripts |
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
| [`packages/octocode-pi-extension`](packages/octocode-pi-extension) | `@octocodeai/pi-extension` | The Pi harness extension. Bundles the native tool set (from the external brain packages), the `octocode` + `octocode-awareness` CLIs, the system prompt, Awareness wiring, and launcher-consumed Octocode surface/profile helpers; sets `$OCTOCODE_CLI` and `$OCTOCODE_AWARENESS_CLI` at load. This is where the agent gets its tools, skills, prompt, and core runtime policy. | [docs index](packages/octocode-pi-extension/docs/README.md) · [TOOLS](packages/octocode-pi-extension/docs/TOOLS.md) · [AWARENESS flow](packages/octocode-pi-extension/docs/AWARENESS_AGENT_FLOW.md) · [REFLECT](packages/octocode-pi-extension/docs/REFLECT.md) · [OVERRIDES](packages/octocode-pi-extension/docs/OVERRIDES.md) |
| [`packages/octocode-awareness`](packages/octocode-awareness) | `@octocodeai/octocode-awareness` | Shared-repo coordination + memory/hooks/reflection (SQLite, zero npm runtime deps). Owns plans/tasks/WORK, file locks, signals, verification, and reflection. Canonical skill source: repo-root `skills/octocode-awareness`. Local build lives in `packages/octocode-awareness/out/`: `out/index.js` (programmatic/library entry) + `out/octocode-awareness.js` (CLI binary). | [AGENTS](packages/octocode-awareness/AGENTS.md) · [docs index](packages/octocode-awareness/docs/README.md) · [HOW_IT_WORKS](packages/octocode-awareness/docs/HOW_IT_WORKS.md) |
| [`packages/octocode-agent`](packages/octocode-agent) | `octocode-agent` | Branded self-working agent CLI — launches Pi with `@octocodeai/pi-extension` as the harness. Owns launch/update/setup/auth/doctor/session UX and process execution only; imports core policy directly from the extension rather than keeping shims. One command (`octocode-agent`), one update path. | [docs index](packages/octocode-agent/docs/README.md) · [PI_INTEGRATION](packages/octocode-agent/docs/PI_INTEGRATION.md) |

Config: `@octocodeai/config` is external to this checkout. `packages/octocode-pi-extension/src/env.ts` re-exports it for repo-time use; the extension build inlines it into `dist/env.js` and injects `octocode-config.mjs` into skill script directories.

Octocode CLI: this checkout does not vendor the external `octocode` CLI. Wherever `$OCTO` appears below, use `OCTO='npx octocode'` (or a local build of the sibling `octocode` monorepo when you have one). Prefer the Octocode MCP tools for research; use the CLI for management tasks (`skill`, `lsp-server`, `auth`) and `context`/`tools` introspection.

External (not in this workspace): `@octocodeai/octocode-tools-core` (tool runners / Octokit / security / providers), `@octocodeai/octocode-engine` (Rust/napi: search, minify, AST, LSP, secrets), `@octocodeai/octocode-core` (schemas, tool descriptions, system prompt text), `@octocodeai/mcp` (stdio MCP server), `octocode-mcp-vscode` (VS Code / multi-editor extension). Published from sibling repos, pulled in as npm deps by `@octocodeai/pi-extension`. Never hand-write tool guidance in interface packages.

## Tools

Full field-level reference: run `$OCTO tools <name> --scheme` for exact schemas. Live catalog: `$OCTO tools --json`.

**Research catalog (15)** — dogfood these via MCP or local CLI:

| Family | Tools | Role |
|---|---|---|
| GitHub | `ghSearchCode` · `ghSearchRepos` · `ghSearchPullRequests` · `ghSearchIssues` · `ghSearchCommits` · `ghGetFileContent` · `ghViewRepoStructure` · `ghCloneRepo` | Remote code/path search, repo discovery, PR/issue/commit research, file read, tree, clone (`ENABLE_CLONE` for clone) |
| Package | `npmSearch` | npm package lookup + source repo |
| Local | `localSearchCode` · `localViewStructure` · `localFindFiles` · `localFindDeadCode` · `localGetFileContent` | Text/regex/AST search, tree, find-by-meta, dead-code candidates, file read (`ENABLE_LOCAL=false` disables the family) |
| LSP | `lspGetSemantics` | definition, references, callers/callees, symbols, types, diagnostics, … |

**Research flow**

- Use the `octocode-research` skill for research/review/change workflows, then call the catalog tools above with live schemas from `$OCTO tools <name> --scheme`.
- The current CLI has no unified search subcommand and the current catalog has no unified query tool; do not invent either route. Use `$OCTO context --compact` for the live protocol.

Evidence: search hits and `localFindDeadCode` results are **candidates**. Prove identity, references, callers, and reachability with `lspGetSemantics` before delete claims; relevance ordering is not proof.

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

In Pi, use `plan` for session/shared execution; stable shared steps, ownership, dependencies, and observed check receipts are projected onto Awareness Lite internally. Advisory file presence, agent registry lifecycle, and mutation-time peer-lock checks are automatic. Do not add manual status, presence, submit, or audit calls to routine solo work.

Activate `octocode-awareness` only when live shared state can change the next action: peers/overlap, shared execution, unread messages, locks, verification debt, recovery, or relevant memory. No public status tool exists; use the Lite CLI for targeted diagnostics/recovery. Use `lock` only for exceptional non-mergeable state, `message` for needed peer coordination, and `memory` when verified learning may change the approach.

`$OCTOCODE_AWARENESS_CLI` points to the bundled Lite diagnostics/recovery CLI; inspect its schema before using backend commands the reduced Pi tools do not expose. The full `octocode-awareness` package (attend / reflect / hooks) applies only when installed. Package work also reads [`packages/octocode-awareness/AGENTS.md`](packages/octocode-awareness/AGENTS.md).

SQLite is canonical; never hand-edit generated files under `.octocode/` or `out/skills/`. Full lifecycle: [`docs/HOW_IT_WORKS.md`](packages/octocode-awareness/docs/HOW_IT_WORKS.md).

## Docs and references

| Area | Links |
|---|---|
| Agent / Pi | [`packages/octocode-agent/docs/README.md`](packages/octocode-agent/docs/README.md) · [`PI_INTEGRATION.md`](packages/octocode-agent/docs/PI_INTEGRATION.md) · pi-extension [`docs/README.md`](packages/octocode-pi-extension/docs/README.md) · [TOOLS](packages/octocode-pi-extension/docs/TOOLS.md) · [AWARENESS flow](packages/octocode-pi-extension/docs/AWARENESS_AGENT_FLOW.md) · [REFLECT](packages/octocode-pi-extension/docs/REFLECT.md) · [OVERRIDES](packages/octocode-pi-extension/docs/OVERRIDES.md) |
| Awareness | [`packages/octocode-awareness/docs/README.md`](packages/octocode-awareness/docs/README.md) — [HOW_IT_WORKS](packages/octocode-awareness/docs/HOW_IT_WORKS.md) · [HOOKS](packages/octocode-awareness/docs/HOOKS.md) · [VERIFY](packages/octocode-awareness/docs/VERIFY.md) · [LOCKS](packages/octocode-awareness/docs/LOCKS.md) · [MEMORY_NAVIGATION](packages/octocode-awareness/docs/MEMORY_NAVIGATION.md) · [WIKI](packages/octocode-awareness/docs/WIKI.md) · [REFERENCES](packages/octocode-awareness/docs/REFERENCES.md) |
| Skills | Repo skill source: [`skills/octocode-awareness`](skills/octocode-awareness) (synced into `packages/octocode-awareness/skills/` at build). Other Octocode skills (research, brainstorming, eval, prompt-optimizer, rfc-generator, roast, skills, subagent) are installed via `node $OCTOCODE_CLI skill --add`. |

Root `docs/` holds harness-wide topics only ([`docs/DISCOVERY.md`](docs/DISCOVERY.md): MCP catalog, skill tool, discovery inventory, context composition). Keep package internals package-local (`packages/*/docs`) or under Awareness docs; command inventories belong to `package.json`, binary help, and `$OCTO tools --json/--scheme`. Global docs (`OCTOCODE_MCP`, `CONFIGURATION`, `SECURITY`, `OCTOCODE_TOOLS`, `OCTOCODE_CLI`, `OQL_*`) and `release/RELEASE_GUIDE.md` live in the sibling `octocode` monorepo, not this repo. Run `$OCTO context` for the live agent protocol + tool playbook.

## Config / env — single source

All env/config loading flows through `@octocodeai/config`. Never reimplement:

- `getOctocodeHome(env?)` — `OCTOCODE_HOME` → platform default
- `propagateOctocodeEnv({ cwd, trusted, env })` — global + project `.env` → `process.env`
- `parseEnv(text)` · `loadOctocoderc(home?)` · `PROTECTED_KEYS`

Skills: `./octocode-config.mjs` (injected at build). Packages: `import { … } from '@octocodeai/config'` or the package-local re-export when one exists.
