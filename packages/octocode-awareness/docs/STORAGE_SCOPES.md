# Agent and Awareness storage

Status: Accepted

Agent runtime state and Awareness coordination state use different SQLite
stores. A process must never initialize one owner's schema in the other owner's
database.

```text
$OCTOCODE_HOME/
├── agent/                              Agent-owned
│   ├── agent.sqlite3                   control and discovery indexes
│   ├── core.sqlite3                    Rust runtime durability
│   ├── sessions/                       per-session Agent artifacts
│   ├── workspaces/                     workspace-keyed Agent configuration
│   ├── skills/
│   └── mcp/
├── awareness/                          optional global Awareness scope
│   └── awareness.sqlite3
└── <other CLI- or MCP-owned data>

<workspace>/.octocode/
├── awareness.sqlite3                  default Awareness coordination store
├── awareness.json                     workspace Awareness policy
├── <Awareness exports and plan docs>
└── <other CLI- or MCP-owned data>
```

`$OCTOCODE_HOME` is normally `~/.octocode`. Resolve it through
`@octocodeai/config`; don't duplicate home-directory logic.

## Ownership matrix

| Owner | Canonical path | Data |
|---|---|---|
| Agent control | `$OCTOCODE_HOME/agent/agent.sqlite3` | Agent settings, discovery/control indexes, and session index data. |
| Agent runtime | `$OCTOCODE_HOME/agent/core.sqlite3` | Sessions and events, effects, lifecycle records, automation leases, worker communication, dependency-work ledgers, revisions, and fencing state. |
| Agent artifacts | `$OCTOCODE_HOME/agent/sessions/` and other directories under `$OCTOCODE_HOME/agent/` | Session artifacts and encoded file-fallback records (`.json`, `.bak`, `.head`, `.segments/`), plus checkpoints, logs, worker handback, browser, media, and other Agent-owned files. |
| Awareness workspace | `<workspace>/.octocode/awareness.sqlite3` | Plans, tasks, claims, work presence, locks, verification, agents, messages, signals, handoffs, memory, and redacted worker-lifecycle coordination projections for that workspace. |
| Awareness policy | `<workspace>/.octocode/awareness.json` | Workspace-selected Awareness storage and hook policy; not runtime or coordination data. |
| Awareness global | `$OCTOCODE_HOME/awareness/awareness.sqlite3` | The same Awareness schema when the caller explicitly selects global scope. Rows remain workspace-scoped where the entity contract requires it. |
| Other CLI/MCP owners | Their documented paths, including other files under `<workspace>/.octocode/` | Research indexes, caches, exports, and service-specific state. These aren't Agent or Awareness databases. |

Authoritative worker lifecycle and runtime durability are Agent-owned.
Awareness can own a bounded, redacted `worker_lifecycle_events` projection for
coordination and restart observation, but it doesn't own worker processes,
mailboxes, worktrees, handoff state, effects, fencing, or Agent sessions.

## Scope and overrides

Awareness defaults to the repository store resolved from `--workspace` or the
current workspace:

```text
<workspace>/.octocode/awareness.sqlite3
```

Use `--db-scope global` only when collaborators deliberately need the optional
global Awareness store. It resolves to:

```text
$OCTOCODE_HOME/awareness/awareness.sqlite3
```

Use `--db <absolute-path>` for an isolated test, recovery operation, or managed
deployment. The explicit path applies to that invocation and still must identify
an Awareness database. `OCTOCODE_AGENT_DB_PATH` changes the Agent control store;
it must not redirect Awareness.

Changing scope changes the physical Awareness database. Agents that intend to
coordinate must select the same workspace and scope. A global Awareness store
doesn't make Agent runtime state global or merge it with Agent databases.

## Repository artifacts

Awareness SQLite is canonical for live coordination. Authored plan documents and
explicit `query` exports under `.octocode/` are files, not a second source of
live state. Don't hand-edit exports or infer current claims, locks, or
verification from them.

Other tools can own databases in the same `.octocode/` directory. Identify a
file by its documented name and database identity, not by its parent directory.

## Migration and legacy stores

Older installations can contain Awareness relations in
`$OCTOCODE_HOME/agent/agent.sqlite3`, or can contain legacy files such as
`<workspace>/.octocode/agent.sqlite3`. Treat these as migration sources, not as
valid targets for a new Awareness open.

A historical `<workspace>/.octocode/agent/` artifact directory is neither the
current global Agent root nor an Awareness database. Preserve it until its
session/checkpoint contents have been inventoried; don't merge it into the new
Awareness file or delete it merely because it is under `.octocode/`.

1. Stop writers to the source store.
2. Preserve a byte-for-byte backup, including any SQLite `-wal` and `-shm`
   companions.
3. Inventory the source identity and recognized relations before copying data.
4. Migrate only Awareness-owned entity families into the selected
   `awareness.sqlite3`; never copy an entire mixed database over an Agent,
   Awareness, CLI, or MCP store.
5. Validate row counts, foreign keys, integrity, schema identity, and the
   workspace mapping before switching writers.
6. Keep the source until the migrated store has passed real CLI operations and a
   restart. Delete legacy data only through a separate, explicit cleanup step.

For the recognized legacy mixed Agent/Awareness schema, migrate all workspaces
to the separate global Awareness store with:

```bash
npx @octocodeai/octocode-awareness coordination maintenance migrate-legacy
```

The defaults are `$OCTOCODE_HOME/agent/agent.sqlite3` as the read-only source
and `$OCTOCODE_HOME/awareness/awareness.sqlite3` as the new target. Use
`--source <path> --target <path>` for an explicit pair. The command refuses an
existing target, unknown identity or relations, schema mismatch, integrity or
foreign-key failures, and row-count mismatches. One read transaction provides a
consistent snapshot, and a `data_version` check rejects source commits detected
during the copy window. This is an additional guard, not a replacement for
stopping writers before migration.

The command copies into a unique temporary database and publishes the verified
target with a same-directory atomic no-overwrite link. Failed runs attempt to
remove temporary database, WAL, shared-memory, and rollback-journal files; an
abnormal termination or filesystem cleanup failure can leave those uniquely
named artifacts for an operator to inspect and remove. A successfully published
target remains a success even if best-effort removal of its temporary hard link
fails. The command never deletes or rewrites the source. It preserves the old
all-workspaces semantics in global Awareness scope; it doesn't guess how to
split relational data by repository.

An `OCTA` Agent control file can still contain inert Awareness relations from a
historical mixed installation. The Agent accepts that file so its own control
data remains usable and the explicit migration command has a source. New
Awareness opens reject it, and no Agent path creates or updates those legacy
Awareness relations. Removing them is a separate cleanup operation after the
migrated store has been verified; database identity alone is not a table-purity
claim for this transitional source.

The presence of legacy Awareness tables in an `OCTA` file doesn't prove whether
a migration already completed. Use the migration receipt and validate the
selected target; don't infer migration status from source residue.

## Operational checks

Use owner-specific commands rather than editing SQLite directly:

```bash
npx @octocodeai/octocode-awareness maintenance init --workspace "$PWD" --compact
npx @octocodeai/octocode-awareness workspace status --workspace "$PWD" --compact
```

For the optional global Awareness scope:

```bash
npx @octocodeai/octocode-awareness maintenance init --db-scope global --compact
npx @octocodeai/octocode-awareness workspace status --workspace "$PWD" --db-scope global --compact
```

For an isolated check:

```bash
npx @octocodeai/octocode-awareness maintenance init --db /absolute/path/awareness.sqlite3 --compact
```

Inspect Agent runtime health through the native Agent commands and Rust service
checks documented in the [native Agent README](../../octocode-agent/README.md)
and [Rust core README](../../octocode-agent-core-rust/README.md). See
[DB.md](DB.md) for schema ownership and fail-closed identity checks.
