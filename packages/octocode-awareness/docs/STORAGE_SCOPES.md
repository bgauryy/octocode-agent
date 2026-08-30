# Agent storage

Status: Accepted

All durable agent state uses one global SQLite database:

```text
$OCTOCODE_HOME/
├── agent/
│   ├── agent.sqlite3
│   ├── sessions/
│   ├── workspaces/
│   ├── skills/
│   └── mcp/
├── <CLI-owned files and databases>
└── <MCP-owned files and databases>
```

The agent owns only `$OCTOCODE_HOME/agent/`. The Octocode CLI and MCP server can
own other files under `$OCTOCODE_HOME`; agent code must not reuse or overwrite
those paths. Repository `.octocode/` directories are not default agent database
or artifact locations.

## Database contract

`$OCTOCODE_HOME/agent/agent.sqlite3` is the only default agent database. The
coordination, continuity, session, settings, and advanced Awareness modules use
separate table families in that physical store. Workspace isolation remains
logical through `workspace_path` and related scope columns.

`OCTOCODE_AGENT_DB_PATH` overrides the database for an explicitly managed
deployment or test. An explicit `--db <absolute-path>` affects only that CLI call.
Storage-scope flags remain accepted where required by command contracts, but they
don't select a repository database.

## Artifacts

Session, plan, log, browser, worker handback, discovery, and temporary media
artifacts live under `$OCTOCODE_HOME/agent/`. Workspace-specific artifacts use a
stable workspace key beneath `agent/workspaces/`, so multiple repositories don't
collide while still sharing one global agent home.

Authored repository files and explicit query exports are not database state. A
user can still request an export path inside a repository; SQLite remains
authoritative.

## Operational checks

Use the CLI rather than editing SQLite directly:

```bash
npx @octocodeai/octocode-awareness init --compact
npx @octocodeai/octocode-awareness workspace status --workspace "$PWD" --compact
```

For isolated testing, provide an explicit database:

```bash
npx @octocodeai/octocode-awareness init --db /absolute/path/agent.sqlite3 --compact
```

See [DB.md](DB.md) for table ownership and fail-closed schema checks, and
[HOW_IT_WORKS.md](HOW_IT_WORKS.md) for the agent lifecycle.
