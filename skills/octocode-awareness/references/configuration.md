# Awareness Configuration

The optional global configuration lives at `<OCTOCODE_HOME>/awareness.json`, normally
`~/.octocode/awareness.json`. The CLI owns parsing, validation, and creation.

## Missing-file onboarding

Run `<cli> config show --compact` before the first Awareness operation. When it reports
`exists:false`, ask the user every question below in one prompt and wait for all answers:
Until a valid file exists, Awareness hook entrypoints stay inert.

1. Enable Awareness host-hook automation? Default: `true`.
2. Allow hooks to deliver peer, handoff, and relevant memory context? Default: `true`.
3. Allow stop hooks to remind or block on unverified work? Default: `true`.
4. Allow compact/end hooks to capture resumable session context? Default: `true`.
5. Allow bounded maintenance-pressure reminders from hooks? Default: `false`.

Do not silently accept defaults. Create the file only after the answers:

```bash
<cli> config init \
  --hooks <true|false> \
  --notifications <true|false> \
  --verification-gate <true|false> \
  --session-capture <true|false> \
  --maintenance-reminders <true|false> \
  --compact
<cli> config validate --compact
```

`config init` requires all five answers and refuses to overwrite. For an existing file,
edit it only with normal user authorization and run `config validate` afterward.

## Default file

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

Unknown/missing keys, wrong types, malformed JSON, and unsupported versions are errors.
Environment kill switches still win when they disable an automatic feature.
Machine-readable contract: [awareness-config.schema.json](awareness-config.schema.json).

## Supported boundary

The file controls automatic shell-hook behavior only. `hooks:false` makes installed
Awareness hook entrypoints inert. Other toggles control notification context,
verification reminders, session capture, and maintenance reminders while hooks remain on.
Install/check/remove supports `claude`, `codex`, and `cursor`; Pi uses native
`@octocodeai/pi-extension` events and is not controlled or installed through this file.

It cannot disable explicit CLI commands, evidence requirements, database integrity checks,
or only one half of mutation lock enforcement/presence. Database locations remain owned by
`OCTOCODE_HOME`, `OCTOCODE_MEMORY_HOME`, and `OCTOCODE_DB_PATH`.

Configuration is preference, not authorization. Before every real `hooks install`, show
the noncompact dry-run target and ask the user again. Approval to create `awareness.json`
never authorizes host configuration changes.
