# Awareness Configuration

Awareness has two separate configurations:

- An optional `<workspace>/.octocode/awareness.json` selects logical
  coordination/memory scope behavior and the hook profile. Scope settings don't
  select a repository database; durable state remains in the default global
  agent database unless the caller supplies an explicit override.
- `$OCTOCODE_HOME/awareness.json` controls global automatic-feature preferences.

Awareness reads global automatic-feature preferences from
`$OCTOCODE_HOME/awareness.json`, normally `~/.octocode/awareness.json`.
Explicit CLI operations do not require this file. Before enabling shell-hook
automation, complete the onboarding below; automatic hook entrypoints stay inert
until the file exists and validates.

## Configure shell-hook automation

```bash
npx @octocodeai/octocode-awareness config show --compact
```

When missing, the result returns the complete five-question questionnaire and the
recommended value for each option. Ask all questions together. After the operator answers:

```bash
npx @octocodeai/octocode-awareness config init \
  --hooks <true|false> \
  --notifications <true|false> \
  --verification-gate <true|false> \
  --session-capture <true|false> \
  --maintenance-reminders <true|false> \
  --compact
npx @octocodeai/octocode-awareness config validate --compact
```

Initialization requires every value, creates a private file, and refuses overwrite.
Validation rejects malformed JSON, unknown or missing keys, wrong types, and versions
other than `1`. The bundled skill includes the machine-readable
`references/awareness-config.schema.json` contract.

## Defaults

```json
{
  "version": 1,
  "features": {
    "hooks": true,
    "notifications": true,
    "verificationGate": true,
    "sessionCapture": true,
    "maintenanceReminders": false
  }
}
```

| Feature | Effect when disabled |
|---|---|
| `hooks` | Installed Awareness shell-hook entrypoints become inert. |
| `notifications` | Hooks do not inject peer, handoff, or relevant-memory context. |
| `verificationGate` | Stop hooks do not surface verification debt. Explicit audits remain available. |
| `sessionCapture` | Compact/end hooks do not create resumable captures; lifecycle cleanup still runs. |
| `maintenanceReminders` | Hooks do not emit maintenance-pressure reminders. |

The file does not disable explicit CLI operations, evidence rules, database integrity,
or only one half of the mutation guard/presence pair. Existing environment kill switches
remain supported and take precedence when disabling automation. `--db-scope repo|global`
overrides logical scope behavior for one call; it doesn't select a repository
database. `OCTOCODE_HOME`, `OCTOCODE_AGENT_DIR`, and
`OCTOCODE_AGENT_DB_PATH` resolve global locations, and `--db` selects an explicit
database path for one call.
See [storage scopes](STORAGE_SCOPES.md).

Hook profiles are `guard`, `coordination`, and `full`. Host support, event mappings,
installation surfaces, and verification commands are owned only by
[`HOOKS.md`](HOOKS.md). Pi uses native `@octocodeai/pi-extension` events and is not
installed through the shell-hook settings path.

Preferences are not authorization. A real `hooks install` always requires a separate
preview and explicit user approval immediately before the host settings mutation.
