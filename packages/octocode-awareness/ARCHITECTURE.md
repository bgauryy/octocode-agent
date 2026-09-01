# Awareness architecture

`@octocodeai/octocode-awareness` owns durable coordination, memory, hooks,
reflection, and recovery for coding agents. It remains independent of
`@octocodeai/agent-core`; hosts translate Awareness facts through adapters.

## Ownership

- `src/coordination/` owns the shared plans, tasks, work presence, locks,
  messages, handoffs, memory, agent registry, verification, and command schema.
- `src/db-runtime.ts`, `src/db-schema.ts`, `src/sql/`, and schema modules own
  SQLite opening, identity, migrations, statements, and maintenance.
- `src/attend-*`, signals, refinements, sessions, query, digest, reflection, and
  maintenance modules own the advanced operating and learning workflows.
- `bin/` owns CLI parsing and presentation; domain behavior remains in `src/`.
- The repository-root `skills/octocode-awareness/` directory is the canonical
  skill source. Package-local and installed mirrors are build output.
- `@octocodeai/octocode-shared` owns shared database paths, control tables,
  entities, and cross-host protocol fragments.

## Storage and process boundaries

SQLite is canonical. All durable agent state uses
`$OCTOCODE_HOME/agent/agent.sqlite3` by default, with logical workspace isolation
inside that store. An explicit `--db` path creates an isolated override for one
call. Files under `.octocode/` are plans, exports, and discovery pointers; they
are not a second live database.
The package uses Node's built-in SQLite runtime and has no npm runtime
dependencies of its own.

## Coordination flow

```text
CLI, host hook, or in-process adapter
  -> coordination command dispatcher
  -> plans/tasks/work/locks/messages/verification/memory owner
  -> shared SQLite transaction primitives
  -> one canonical agent database
  -> compact result or explicit export
```

Awareness messages, signals, outbox entries, and verification receipts are
coordination records. They aren't agent-core lifecycle events. Native and Pi
adapters translate relevant records into their host context and acknowledge
delivery only after the owning persistence boundary succeeds. Hooks automate
declared coordination edges; they don't infer goals, claim verification, or turn
advisory presence into an exclusive lock.

## Dependency rules

- Do not import the agent runtime, Pi, OpenTUI, or host UI policy.
- Route SQL through the module that owns the relation; do not add statements to
  CLI or presentation modules.
- Treat presence as advisory and exclusive locks as exceptional protection for
  non-mergeable work.
- Record verification only from observed checks. Memory and peer messages are
  leads, not execution proof.
- Update the canonical skill source and rebuild; do not edit generated mirrors.

See [how Awareness works](docs/HOW_IT_WORKS.md), the [database reference](docs/DB.md),
and the [documentation index](docs/README.md).
