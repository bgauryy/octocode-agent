# Awareness Configuration

Load when choosing storage scope, hook policy, identity, or repository ownership.

## Storage and automation

Durable state uses `$OCTOCODE_HOME/agent/agent.sqlite3`; workspace columns isolate repositories. `--db` is only for an explicit isolated path. Inspect global hook automation with `config show --compact`. Never copy config parsing: the runtime uses `@octocodeai/config` and `OCTOCODE_HOME`.

## Identity and trust

Use one stable `OCTOCODE_AGENT_ID` per cooperating identity. Workspace paths must normalize to the same absolute root. Configuration proves preferences only; it does not prove host trust, hook execution, or model-visible delivery.

## Hook policy

| Profile | Purpose |
|---|---|
| `guard` | Block real exclusive conflicts and protect write safety. |
| `coordination` | Guard plus bounded presence and shared-state pointers. |
| `full` | Coordination plus the broadest supported lifecycle coverage. |

Hook installation mutates host configuration. Always show a noncompact dry-run immediately before applying and require explicit approval. Then install and strict-check the same host/scope. Pi uses native events and never shell-hook installation.

For first hook enablement, ask together: hook profile, host, and project/global destination. These answers are not installation approval.

Use `references/hooks.md` for lifecycle coverage and runtime smoke checks. Use `references/architecture.md` for database ownership and path normalization.

Next: return to `SKILL.md` after any requested automation change is verified.
