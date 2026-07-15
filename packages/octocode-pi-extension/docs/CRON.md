# Octocode Session Jobs

`@octocodeai/pi-extension` runs lightweight session-scoped jobs while Pi is open.
They are deliberately **not** OS cron: timers start on `session_start` and are
cleared on `session_shutdown`, `/new`, reload, resume, fork, or quit.

## Safety model

- Default jobs are report-first and non-mutating.
- The built-in maintenance job runs Awareness with `--dry-run`.
- No job calls a model.
- Jobs never run when `OCTOCODE_CRON=0`.
- Mutating cleanup such as `memory forget` or `wiki sync` remains manual.

## Commands

```text
/octocode-cron list
/octocode-cron check [default|all|job]
/octocode-cron cancel [default|all|job]
/octocode-cron help
```

`list` shows every session job. Bare `check` runs the default job
(`maintenance-digest`); `check all` runs every registered job; `check <job>` runs
one named job. `cancel` follows the same target rules and disables timers for the
current session only.

## Default job

| Job | Interval | Action |
|---|---:|---|
| `maintenance-digest` | 30 min | `node $OCTOCODE_AWARENESS_CLI maintenance digest --workspace <cwd> --dry-run --compact` |

## Configuration

| Variable | Default | Effect |
|---|---:|---|
| `OCTOCODE_CRON` | `1` | Set `0` to disable all session jobs. |
| `OCTOCODE_CRON_DIGEST` | `1` | Set `0` to leave the digest job unscheduled. |
| `OCTOCODE_CRON_DIGEST_INTERVAL_MS` | `1800000` | Override digest interval in milliseconds. |

The scheduler requires `$OCTOCODE_AWARENESS_CLI`. If it is absent, manual and
scheduled runs are skipped with a visible message instead of failing the session.
