# Awareness Configuration

Load when choosing storage scope, hook policy, identity, or repository ownership.

## Setup

Start with `setup --compact` and inspect `config show`. Persist policy once:

```bash
<cli> setup --repository-scope repo|global --memory-scope repo|global \
  --hook-profile guard|coordination|full --compact
```

Repository scope owns coordination state. Memory scope owns reusable learning. `--db-scope` is a one-call override; `--db` is only for an explicit path. Never copy config parsing: the runtime uses `@octocodeai/config` and `OCTOCODE_HOME`.

## Identity and trust

Use one stable `OCTOCODE_AGENT_ID` per cooperating identity. Workspace paths must normalize to the same absolute root. Configuration proves preferences only; it does not prove host trust, hook execution, or model-visible delivery.

## Hook policy

| Profile | Purpose |
|---|---|
| `guard` | Block real exclusive conflicts and protect write safety. |
| `coordination` | Guard plus bounded presence and shared-state pointers. |
| `full` | Coordination plus the broadest supported lifecycle coverage. |

Hook installation mutates host configuration. Always show a noncompact dry-run immediately before applying and require explicit approval. Then install and strict-check the same host/scope. Pi uses native events and never shell-hook installation.

For first hook enablement, ask together: repository scope, memory scope, hook profile, host, and project/global destination. These answers are not installation approval.

Use `references/hooks.md` for lifecycle coverage and runtime smoke checks. Use `references/architecture.md` for database ownership and path normalization.

Next: return to `SKILL.md` after the policy is persisted and verified.
