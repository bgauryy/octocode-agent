# Octocode Awareness

<p align="center">
  <img src="assets/logo.png" alt="Octocode Awareness" width="300" />
</p>

One local communication and coordination layer for coding agents sharing a workspace. SQLite is canonical; there is no server or daemon.

## Install

Requires Node 22.13 or newer.

```bash
npm install --global @octocodeai/octocode-awareness
npx octocode skill --add \
  --path "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness" \
  --platform common --dry-run
# after reviewing destinations:
npx octocode skill --add \
  --path "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness" \
  --platform common --force
```

`common` installs to `~/.agents/skills`; use `claude`, `cursor`, `codex`, or `pi` for hosts that do not scan it. The package bundles only the `octocode-awareness` skill. Diagnose the installed runtime with:

```bash
node "$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness/scripts/install.mjs"
```

## One shared external-agent surface

Pi imports `@octocodeai/octocode-awareness` in-process. External agents use the `octocode-awareness` bin from this same package:

```bash
npx -p @octocodeai/octocode-awareness octocode-awareness status --workspace "$PWD"
npx -p @octocodeai/octocode-awareness octocode-awareness guide
npx -p @octocodeai/octocode-awareness octocode-awareness coordination schema commands
```

In-process hosts import the same contracts instead of recreating policy, flags, or JSON adapters:

```ts
import {
  EXTERNAL_AGENT_AWARENESS_PROMPT,
  formatExternalAgentCoordinationContext,
  readExternalAwarenessStatus,
  executeExternalMemoryAction,
  projectExternalPlan,
} from '@octocodeai/octocode-awareness';
```

Both use the workspace-scoped shared database at `~/.octocode/octocode.sqlite3`, overridden by `OCTOCODE_HOME` or `OCTOCODE_DB_PATH`. The workspace `.octocode/` directory is for authored plans, handoffs, and `.octocode/REFLECT.md`; it is not the database. `~/.octocode/` is global Octocode home state.

The same root binary also exposes reflection, query, session, digest, and maintenance workflows. Shared-ledger verbs use `coordination` when a name would otherwise be ambiguous.

## Feature inventory

| Family | Shared capability |
|---|---|
| Status | Read-only counts for active plans, ready/in-progress tasks, verification debt, active locks/work, agents, messages, handoffs, and memory. |
| Plans | Create, list, inspect, complete, or abandon shared plans. |
| Tasks | Acceptance criteria, paths, priority, dependencies, readiness, claim leases, heartbeat/release, completion, and reopen. |
| Work presence | Advisory start/touch/list/show/end declarations for files being edited. |
| Locks | Exclusive acquire/wait/list/release/prune for sensitive or non-mergeable state. |
| Checks | Audit verification debt and attach exact success/failure receipts; task completion alone is not proof. |
| Messages | Direct or broadcast inbox messages with topics, file references, read state, and explicit pruning. |
| Agents | Join, heartbeat/status, list/staleness interpretation, and leave. |
| Handoffs | Add, list, and clear concise continuation notes with related files. |
| Memory | Store, lexical/optional semantic recall, list, reindex, forget, and dry-run-first pruning. Memory is a lead, not evidence. |
| Hooks | Optional Claude/Codex/Cursor pre-edit lock gate; dry-run installation first. Pi integrates checks in-process. |
| Schema | Machine-readable command and entity contracts so hosts do not guess flags or payloads. |
| Pi composition | Native plan, lock, message, and memory tools plus automatic registry, presence, and mutation-time conflict checks over the same dispatcher and DB. |
| Runtime workflows | Attend/workboard, signals, refinements, sessions, reflection, query exports, digests, and maintenance from the same root CLI. |

All CLI results are JSON. Mutation results preserve the entity and may add a typed `next` action. `status` filters expired leases without mutating stored rows; cleanup is explicit.

## Database entities

The shared Pi/external database contains nine Awareness tables: `plans`, `tasks`, `locks`, `work_presence`, `handoffs`, `memories`, `agents`, `messages`, and `message_receipts`. It also co-locates Octocode control tables owned by `@octocodeai/octocode-shared`: `octocode_meta`, `agent_sessions`, `mcp_server_overrides`, `mcp_tool_overrides`, `skill_overrides`, and `mcp_catalog_state`.

Runtime workflow entities include `sessions`, `memory_refs`, `plan_members`, `plan_docs`, `task_paths`, `task_dependencies`, `task_claims`, `task_events`, `task_runs`, `run_files`, `delivery_state`, `hook_receipts`, `run_log`, `refinements`, `signals`, `signal_reads`, `edit_log`, and `harness_log`.

## Agent rules

- Derive steps, decisions, and completion claims from repository or check evidence.
- Ordinary overlap is visible and allowed; lock only genuinely unsafe overlap.
- Keep presence/leases alive while working, run checks before teardown, and mark the receipt after `task done`.
- Store only verified reusable memory. Keep workspace reflection concise in `<workspace>/.octocode/REFLECT.md`; never confuse it with global `~/.octocode` state.

See [docs/SKILLS.md](docs/SKILLS.md) for the operating guide, [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) for architecture, [docs/VERIFY.md](docs/VERIFY.md) for end-to-end checks, and [docs/README.md](docs/README.md) for the complete documentation index including [docs/THESIS.md](docs/THESIS.md) and [docs/REFERENCES.md](docs/REFERENCES.md).

## Develop and verify

```bash
yarn workspace @octocodeai/octocode-awareness build
yarn workspace @octocodeai/octocode-awareness verify
```

Edit the canonical skill only under repo-root `skills/octocode-awareness`; the build refreshes package, `out/`, and `.agents/skills/` mirrors.
