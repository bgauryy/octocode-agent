# Awareness databases

Awareness currently exposes two explicit local SQLite planes. Shared coordination
uses the workspace-scoped `octocode.sqlite3` resolved by
`@octocodeai/octocode-shared/paths` (`OCTOCODE_HOME` / `OCTOCODE_DB_PATH`). Advanced
workflow commands use `$OCTOCODE_MEMORY_HOME/awareness.sqlite3`, or the platform
memory-home path resolved by `src/db-runtime.ts`; `--db` overrides that path.

Do not substitute similarly named commands or database overrides across the planes.
The shared store deliberately co-locates coordination, continuity, control, and
advanced-compatible auxiliary relations. The advanced OCT1 store remains the strict
contract for `attend`, runs, signals, reflection, maintenance, and query exports.

`<workspace>/.octocode/` is not the database. It holds optional read-only query
exports written on request for readers that cannot query Awareness directly, plus
authored plan narrative. SQLite remains authoritative.

## Shared-store contract

`src/coordination/coordination-migration.ts` owns the shared coordination and
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

## Advanced OCT1 contract

`src/db-schema.ts` owns all advanced table, index, and optional FTS DDL. There is one
current OCT1 contract and one application identity:

```text
application_id = 0x4f435431  # ASCII OCT1
```

The application ID distinguishes Awareness from unrelated SQLite files. The
normalized schema fingerprint distinguishes the exact executable contract.
There is no second initializer or parallel numeric contract field.

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

Startup accepts only two states:

1. An empty SQLite store, which is initialized from the canonical DDL.
2. An OCT1 store whose relations and normalized fingerprint match exactly.

Any other application ID, unbranded non-empty store, missing relation, extra
relation, or changed DDL is rejected before Awareness writes application data.
This fail-closed boundary prevents the package from guessing ownership or
silently reshaping an incompatible database.

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

An exact fingerprint means a DDL edit is a contract change. Coordinate such a
change explicitly and create a fresh store; do not add an alternate initializer
or a numeric field that allows two definitions to coexist.

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
