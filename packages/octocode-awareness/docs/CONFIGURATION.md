# Awareness Configuration

Awareness reads global automatic-feature preferences from
`<OCTOCODE_HOME>/awareness.json`, normally `~/.octocode/awareness.json`.
The file is optional for runtime compatibility, but the Awareness skill treats a
missing file as onboarding that requires user answers before it operates.
Automatic hook entrypoints stay inert until the file exists and validates.

## Onboard

```bash
npx @octocodeai/octocode-awareness config show --compact
```

When missing, the result returns the complete five-question questionnaire and the
recommended value for each option. Ask all questions together. After the user answers:

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
remain supported and take precedence when disabling automation. Database paths continue
to use `OCTOCODE_HOME`, `OCTOCODE_MEMORY_HOME`, and `OCTOCODE_DB_PATH`.

Hook install/check/remove supports `claude`, `codex`, and `cursor`. Pi uses native
`@octocodeai/pi-extension` events and is not controlled or installed through this file.

Preferences are not authorization. A real `hooks install` always requires a separate
preview and explicit user approval immediately before the host settings mutation.
