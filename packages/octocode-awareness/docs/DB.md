# Awareness databases

Awareness uses one global agent database at
`$OCTOCODE_HOME/agent/agent.sqlite3`. Coordination, continuity, control, sessions,
and advanced workflow modules own distinct table families in that physical store.
[STORAGE_SCOPES.md](STORAGE_SCOPES.md) defines placement, overrides, and artifacts.

The agent owns only `$OCTOCODE_HOME/agent/`. Databases and configuration elsewhere
under `$OCTOCODE_HOME` can belong to the Octocode CLI or MCP server and must not be
opened as the agent database. Repository `.octocode/` directories are not default
agent storage. SQLite remains authoritative; explicit exports are read surfaces.

## Coordination table contract

`src/coordination/coordination-schema.ts` owns the shared coordination and
continuity DDL. Its fifteen primary entities are:

- coordination: `plans`, `tasks`, `locks`, `work_presence`, `handoffs`, `memories`,
  `agents`, `messages`, `message_receipts`;
- continuity: `event_outbox`, `event_consumers`, `event_acknowledgements`,
  `pending_interactions`, `authorization_receipts`, `capability_receipts`.

The store also initializes eighteen advanced-compatible auxiliary relations and six
Octocode control relations. `tests/database-shared-contract.test.ts` asserts the exact
39-table application set, hot-path indexes, integrity, and foreign keys.

Entity operations are split by domain under `src/coordination/`: plans/tasks and plan
graphs; lock/work/handoff/check state; memory/agent/message operations; continuity;
schema/dispatch; and host adapters. This domain split avoids both one giant store file
and one tiny file per SQL statement.

## Advanced Awareness table contract

`src/db-schema.ts` owns all advanced table, index, and optional FTS DDL. The complete
agent database has one application identity:

```text
application_id = 0x4f435441  # ASCII OCTA
```

The application ID distinguishes agent state from unrelated CLI, MCP, and foreign
SQLite files. Module fingerprints distinguish each executable table contract, and
`agent_schema_modules` records their versions without assigning a second database
identity.

The advanced database layer is split by responsibility:

- `db-runtime.ts` opens connections, classifies stores, chooses journal mode,
  applies retry bounds, and exposes cached connections.
- `db-init.ts` serializes first initialization and creates the contract.
- `db-schema.ts` contains the executable DDL.
- `db-introspection.ts` derives the expected relation set and fingerprint.
- `db-maintenance.ts` owns FTS index rebuild, memory-reference bookkeeping, and
  expired-lock eviction. It is not the query/filter layer — that's `repo-scope.ts`
  (shared parameterized scoping helpers) and the `repo-*.ts` row builders.
- `db.ts` is the public barrel.

Its 23 application tables are validated exactly by
`tests/database-advanced-contract.test.ts`; optional `memories_fts` and its SQLite
shadow tables are validated separately.

## Query ownership

The 16 live views are enumerated once by `AWARENESS_QUERY_VIEWS` in `repo-model.ts`.
`repo-query.ts` dispatches them to focused row-builder modules:

| Views | Owner |
|---|---|
| `repo-profile`, `files`, `activity` | `repo-files.ts` |
| `memories`, `gotchas`, `lessons`, `plans`, `tasks`, `runs` | `repo-plans.ts` |
| `locks`, `agents`, `signals`, `refinements`, `developer-review` | `repo-coordination.ts` |
| `workboard` | `repo-workboard.ts` |
| `all` | `repo-query.ts` fan-out with bounded section completeness |

Formatting is isolated in `repo-formats.ts`, scoping in `repo-scope.ts`, and writes in
`repo-projection.ts`. `tests/query-contract-matrix.test.ts` executes every view through
JSON, table, CSV, Markdown, and HTML—80 view/format combinations.

## Startup contract

Startup accepts only an empty store or an OCTA agent store containing recognized
module relations. Any foreign application ID, unknown relation, partial module, or
changed module DDL is rejected before agent DDL writes application data. This
fail-closed boundary prevents the package from guessing ownership or reshaping a
CLI or MCP database.

Fresh initialization runs under `BEGIN IMMEDIATE`. A second process that opens
the same empty path waits on the bounded SQLite busy retry, reclassifies the
store after acquiring the write lock, and observes the completed contract. The
application ID is written only after DDL, indexes, optional FTS, fingerprint,
integrity, and foreign-key checks succeed.

`initDb(db)` rejects caller-owned transactions because it must own that complete
serialization boundary. `connectDb(path)` is the normal file-backed entry point.

## SQLite runtime safety

The embedded SQLite library version controls journal selection:

- Runtime builds known to be safe use WAL for concurrent readers and writers.
- Other builds use rollback journaling.

This is a runtime capability check, not a database contract number. Both paths
set a bounded busy timeout and use the same retry deadline around journal mode
and first initialization.

Foreign keys are enabled on every returned connection. Initialization briefly
disables connection-local enforcement while creating the complete empty
contract, then restores it before returning.

## Integrity and fingerprint checks

The canonical fingerprint covers tables, named indexes, views, triggers, and
the optional `memories_fts` virtual table. SQLite-generated internal objects and
FTS shadow tables are excluded.

Initialization and canonical opens enforce:

- the complete expected relation set;
- no unexpected application relations;
- normalized DDL equality;
- `PRAGMA integrity_check`;
- `PRAGMA foreign_key_check`.

An exact module fingerprint means a DDL edit is a contract change. Coordinate such
a change explicitly; don't add another physical agent database or a numeric field
that allows two definitions to coexist.

## FTS

FTS5 is optional because the embedded SQLite build may omit it. When available,
`memories_fts` is created from `FTS_SCHEMA_DDL` and rebuilt from the empty
canonical memory tables during initialization. Search helpers detect its
presence at runtime and retain non-FTS behavior when unavailable.

## Operational checks

Database-facing CLI results have one shape per action. `work list|show` returns
flat work rows for direct inspection; Attend's `FilesUnderWork` groups those
rows for coordination summaries.

Use the package CLI and tests rather than editing the database manually:

```bash
yarn workspace @octocodeai/octocode-awareness test
yarn workspace @octocodeai/octocode-awareness test:smoke
yarn workspace @octocodeai/octocode-awareness lint
```

The concurrency contract is covered by `tests/concurrent-init.test.ts`. Schema
identity, drift rejection, idempotence, FTS behavior, and delivery-state helpers
are covered by `tests/schema.test.ts`.

If a store is rejected, preserve it for inspection and point Awareness at a new
path. Automatic transformation of an unrecognized store is intentionally
outside the runtime contract.
