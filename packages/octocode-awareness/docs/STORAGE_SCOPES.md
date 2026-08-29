# Awareness storage scopes

Status: Accepted

Awareness supports repository and global SQLite storage. Workspace policy defaults
repository-owned commands to `repo` and reusable-memory commands to `global`. Set it once
with `setup`; use `--db-scope repo|global` only for a single-call override. An explicit
`--db <path>` overrides both.

## Decision

Use repository storage for operational state that belongs to one checkout. Use global
storage only when a feature must span repositories or belongs to the local Octocode
installation.

| Existing store | Repository database | Global database |
|---|---|---|
| Shared coordination | `<workspace>/.octocode/octocode.sqlite3` | `$OCTOCODE_HOME/octocode.sqlite3` |
| Advanced workflow | `<workspace>/.octocode/awareness.sqlite3` | `$OCTOCODE_MEMORY_HOME/awareness.sqlite3` |

When `OCTOCODE_MEMORY_HOME` is unset, the global advanced database lives under
`$OCTOCODE_HOME/memory/`. `OCTOCODE_DB_PATH` continues to control the global shared
coordination database. The package config loader owns environment and platform-default
resolution.

Both levels retain `workspace_path` columns. Repository databases use those columns for
integrity and future import/export checks; global databases also use them to isolate rows
from different workspaces.

## Feature placement

| Prefer repository scope | Prefer global scope |
|---|---|
| Plans, tasks, work presence, locks, checks, messages, and handoffs | Agent sessions and machine-level control state |
| Repository signals, refinements, and verification debt | Cross-repository memory and maintenance |
| `attend`, workboard, and repository query views | Cross-workspace audits and registry views |

The policy lives at `<workspace>/.octocode/awareness.json`. It is a thin routing layer over
the two existing stores; it does not merge schemas or copy rows. Global automatic-feature
preferences and host hook definitions remain global or host-owned.

## CLI usage

Set the normal split once:

```bash
npx @octocodeai/octocode-awareness setup --workspace "$PWD" \
  --repository-scope repo --memory-scope global --hook-profile coordination
npx @octocodeai/octocode-awareness next --workspace "$PWD"
npx @octocodeai/octocode-awareness inspect workboard --workspace "$PWD"
```

Commands and hooks load the same repository policy, so normal work does not repeat a scope
flag. Expert commands remain available underneath the façade.

Use global storage when the command must see state from more than one repository:

```bash
npx @octocodeai/octocode-awareness memory recall \
  --query "migration lesson" --all-workspaces --db-scope global --compact
```

Use `--db` only for tests, recovery, or an explicitly managed deployment:

```bash
npx @octocodeai/octocode-awareness maintenance init \
  --db /absolute/path/awareness.sqlite3 --compact
```

## Data compatibility and rollback

The CLI does not copy or delete data when policy changes. Existing releases wrote to
global databases, so use `--db-scope global` to inspect existing state. A repository-level
command creates its database on first use.

Rollback is `setup --repository-scope global --memory-scope global` or deleting only the
workspace policy file to restore defaults. Preserve both databases until checks show the
required state. Never merge SQLite files by copying tables manually.

## Alternatives considered

| Alternative | Decision |
|---|---|
| Keep every table in one global database | Rejected because unrelated repositories share write contention, migration risk, retention, and privacy boundaries. |
| Put every table in each repository | Rejected because sessions, machine-level control, cross-repository memory, and global maintenance need a stable home outside one checkout. |
| Configure one level for all commands | Rejected because storage ownership follows the feature domain. Workspace policy records the split; the explicit flag remains for recovery. |

## Pre-mortem

The most likely failure is an operator writing related commands to different levels and
believing data was lost. Every status result therefore reports its database path, help
defines the level flag, and switching levels never copies or deletes data. The next likely
failure is committing SQLite sidecars; use the narrow ignore rules below. A read-only
workspace cannot use repository scope, so select global scope, or an explicit writable
`--db` path.

## Repository hygiene

Repository databases can create SQLite sidecar files. Ignore only the database files, not
the authored `.octocode/` documents:

```gitignore
.octocode/*.sqlite3
.octocode/*.sqlite3-shm
.octocode/*.sqlite3-wal
```

Each Git worktree has its own repository database. Use global scope when separate worktrees
must deliberately share live state.
