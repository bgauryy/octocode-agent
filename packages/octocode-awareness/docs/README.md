# Octocode Awareness documentation

Each concept has one owner. Command names and schemas come from
`npx @octocodeai/octocode-awareness schema commands --compact`; prose docs do not duplicate the
complete command inventory.

| Document | Owns |
|---|---|
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | Package ownership, storage boundaries, dependency rules, and generated-source policy. |
| [THESIS.md](THESIS.md) | Homeostatic control model, metaphor boundary, pressures, and success measures |
| [HOW_IT_WORKS.md](HOW_IT_WORKS.md) | Canonical complete bootstrap, operating, state, hook, memory, projection, and exit lifecycle |
| [DB.md](DB.md) | SQLite schema, relationships, migration, scope |
| [STORAGE_SCOPES.md](STORAGE_SCOPES.md) | Agent/Awareness path boundary, ownership matrix, overrides, migration, and artifacts |
| [CONFIGURATION.md](CONFIGURATION.md) | Global feature defaults, onboarding questions, validation, and fixed safety boundaries |
| [LOCKS.md](LOCKS.md) | Advisory file work, exclusive locks, verification |
| [HOOKS.md](HOOKS.md) | Host installation and runtime behavior |
| [MEMORY_NAVIGATION.md](MEMORY_NAVIGATION.md) | Compact attend, workboard, delivery budgets |
| [SKILLS.md](SKILLS.md) | User/agent installation and operating recipes |
| [REFLECTION.md](REFLECTION.md) | Learning, failure signatures, human approval |
| [HARNESS.md](HARNESS.md) | Maintainer invariants and verification matrix |
| [VERIFY.md](VERIFY.md) | Any-agent quick, installed, host, monorepo, and release verification runbook |
| [COMPREHENSIVE_AUDIT.md](COMPREHENSIVE_AUDIT.md) | Scored whole-system audit for coordination, storage, delivery, and read cost |
| [FEATURE_SWEEP.md](FEATURE_SWEEP.md) | Isolated end-to-end proof for planning, learning, registry, and maintenance surfaces |
| [REFERENCES.md](REFERENCES.md) | Evidence map, prior art, hypotheses, and design limits |

Agent-facing procedures live under package-local `skills/octocode-awareness/references/` and
are listed by `npx @octocodeai/octocode-awareness docs list --compact`. Start with `flow-matrix`
when choosing among lifecycle paths, then open exactly one deeper reference.

Canonical Awareness data lives in `<workspace>/.octocode/awareness.sqlite3` by
default. `--db-scope global` selects the optional
`$OCTOCODE_HOME/awareness/awareness.sqlite3`; an explicit `--db` path overrides
one call. Agent databases under `$OCTOCODE_HOME/agent/` have a separate owner and
identity.
On request, `query` writes read-only `<workspace>/.octocode/` export snapshots;
managed `.octocode/plan/**` files are plan narrative, not a live task checklist.
