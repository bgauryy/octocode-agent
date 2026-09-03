# Octocode Awareness

<p align="center">
  <img src="assets/logo.png" alt="Octocode Awareness" width="300" />
</p>

One local communication and coordination layer for coding agents sharing a workspace. SQLite is canonical; there is no server or daemon.

## Initialize

Requires Node 22.13 or newer.

```bash
npx @octocodeai/octocode-awareness attend --workspace "$PWD" --compact
```

Durable coordination defaults to `<workspace>/.octocode/awareness.sqlite3`.
CLI use needs no global configuration; configure it only for shell hooks. See
[configuration](docs/CONFIGURATION.md). To initialize the workspace store:

```bash
npx @octocodeai/octocode-awareness maintenance init --compact
```

The package manager owns skill installation. This package bundles only Awareness.

## One shared external-agent surface

```bash
export OCTOCODE_AGENT_ID="${OCTOCODE_AGENT_ID:-my-agent}"
npx @octocodeai/octocode-awareness attend --agent-id "$OCTOCODE_AGENT_ID" --workspace "$PWD" --compact
```

Follow `attend.next`. The routine loop is `work start` → `work end` →
`verify mark` → `verify audit`; the [user guide](docs/SKILLS.md) owns exact flags.

In-process hosts import the same contracts instead of recreating policy, flags, or JSON adapters:

```ts
import {
  EXTERNAL_AGENT_AWARENESS_PROMPT,
  formatExternalAgentAwarenessInstructions,
  formatExternalAgentCoordinationContext,
  readExternalAwarenessStatus,
  executeExternalMemoryAction,
  projectExternalPlan,
} from '@octocodeai/octocode-awareness';
```

`instructions export --format prompt` emits a raw prompt fragment;
`--format agents-md` wraps the same policy in stable replacement markers; and
`--format json` emits a machine-readable envelope. Export writes only to stdout.
Callers own prompt injection or `AGENTS.md` replacement and must replace the
marked block rather than append duplicates.

All durable coordination and memory use the workspace-owned
`.octocode/awareness.sqlite3` by default. `--db-scope global` explicitly selects
`$OCTOCODE_HOME/awareness/awareness.sqlite3`; `--db` selects an isolated
Awareness database for one call. Agent control and runtime databases under
`$OCTOCODE_HOME/agent/` are separate and must never contain Awareness tables.
See [storage scopes](docs/STORAGE_SCOPES.md).

The same root binary also exposes reflection, query, session, digest, and maintenance workflows. Shared-ledger verbs use `coordination` when a name is ambiguous.

Host hook installation is optional and separately approval-gated. Preview the exact
project change, request approval immediately before mutation, and then install and verify:

```bash
npx @octocodeai/octocode-awareness hooks install --host <claude|codex|copilot|cursor|gemini|opencode> --profile coordination --project-dir . --dry-run
npx @octocodeai/octocode-awareness hooks install --host <claude|codex|copilot|cursor|gemini|opencode> --profile coordination --project-dir . --compact
npx @octocodeai/octocode-awareness hooks check --host <claude|codex|copilot|cursor|gemini|opencode> --project-dir . --strict
```

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
| Hooks | Optional host pre-edit lock gate; dry-run installation first. In-process hosts use the same package contracts. |
| Schema | Machine-readable command and entity contracts so hosts do not guess flags or payloads. |
| Host composition | Native host tools may compose registry, presence, and mutation-time conflict checks over the same Awareness dispatcher and store. |
| Coordination workflows | Attend/workboard, signals, refinements, Awareness session captures, reflection, query exports, digests, and maintenance from the same root CLI. |

Operational CLI results are JSON; `--help` and `docs show` intentionally emit text/Markdown. Mutation results preserve the entity and may add a typed `next` action. `status` filters expired leases without mutating stored rows; cleanup is explicit.

## Database entities

Awareness owns plans, tasks, claims, work presence, locks, verification,
coordination messages and handoffs, signals, memory, and related collaboration
records. It does not own Agent sessions, effects, runtime lifecycle, automation,
or authoritative worker runtime ledgers. Awareness does own the redacted
`worker_lifecycle_events` coordination projection. Table totals are intentionally omitted; the executable DDL
and schema tests are the durable inventory. See [docs/DB.md](docs/DB.md) for
entity ownership, schema authorities, and fail-closed identity checks.

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
