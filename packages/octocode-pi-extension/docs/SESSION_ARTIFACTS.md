# Session Artifacts

Every file that Octocode writes during a session — plan pages, screenshots,
compaction snapshots, error logs, and more — lands in one **session artifact tree**
instead of scattered across `/tmp`, `~/.octocode/tmp/`, and various workspace
subdirectories.

---

## Where your files live

All session outputs are written under:

```
<your-workspace>/.octocode/agent/<session-key>/
```

The `session-key` is derived from the session ID (from the Pi session manager)
combined with a SHA-256 fingerprint of the session + workspace, so:

- **Different sessions** in the same workspace get different keys.
- **Same session** always resolves to the same directory, even after restart.
- The key format is: `<slug-of-session-id>-<12-char-hex-hash>` (e.g. `my-session-a3f4b9c12d01`).

---

## Output map

| What | Path inside `<session-key>/` | Written by |
|------|------------------------------|------------|
| Plan page (HTML) | `plan/plan.html` | `plan` tool |
| Plan page (Markdown) | `plan/plan.md` | `plan` tool |
| Plan state snapshot | `plan/state.json` | `plan` tool |
| Plan branch snapshots | `plan/branches/*.json` | `plan` tool |
| Browser screenshots | `browser/screenshots/*.png` | `chromeDebug` tool |
| Chrome session metadata | `browser/port-<N>/session.json` | `chromeDebug` tool |
| Chrome CDP event log | `browser/port-<N>/cdp-events.jsonl` | `chromeDebug` (debug mode) |
| Compaction snapshot | `compaction/<timestamp>-<label>.md` | Compaction hook |
| Latest compaction snapshot | `compaction/latest.md` | Compaction hook |
| Checkpoint store pointer | `checkpoint-ref.json` | Checkpoint engine |
| Error / warning log | `logs/error.txt` | Internal error handler |
| Fallback images (PNGs) | `images/<name>-<timestamp>.png` | `media` |
| Export HTML reference | `export/latest-ref.json` | `/octocode-export` command |
| Session manifest | `manifest.json` | All producers (auto-updated) |

---

## The manifest

Every time a file is written, its relative path is recorded in `manifest.json`
at the session root. You can open it any time to see exactly what the current
session has produced:

```json
// <workspace>/.octocode/agent/<session-key>/manifest.json
{
  "version": 1,
  "sessionKey": "my-session-a3f4b9c12d01",
  "workspace": "/Users/you/myproject",
  "createdAt": "2026-08-24T10:00:00.000Z",
  "updatedAt": "2026-08-24T11:30:42.000Z",
  "producers": {
    "plan": {
      "firstSeenAt": "2026-08-24T10:01:00.000Z",
      "lastSeenAt": "2026-08-24T11:30:42.000Z",
      "paths": ["plan/plan.html", "plan/plan.md", "plan/state.json"]
    },
    "browser": {
      "firstSeenAt": "2026-08-24T10:05:00.000Z",
      "lastSeenAt": "2026-08-24T10:05:02.000Z",
      "paths": ["browser/screenshots/screenshot-1234567890.png"]
    },
    "log": {
      "paths": ["logs/error.txt"]
    }
  }
}
```

---

## Viewing the plan page

The plan HTML file (`plan/plan.html`) auto-refreshes every 10 seconds. You can
open it in a browser directly:

```sh
open "$(ls -dt <workspace>/.octocode/agent/*/plan/plan.html | head -1)"
```

Or use the `localServer` tool inside Octocode to serve it:

```
/octocode-plan
```

The plan page renders:
- Current steps with status icons (todo / doing / done)
- The linked RFC document (if any)
- Decision log entries
- A dependency diagram (Mermaid)

---

## Error logs

The error log captures extension-visible problems: tool failures (`isError: true`),
hook exceptions, and provider HTTP errors ≥ 400.

```sh
# Find the current session's error log
ls -t <workspace>/.octocode/agent/*/logs/error.txt | head -1 | xargs cat
```

Each entry includes: timestamp, uptime, source, cwd, model, severity, duration
(for tool/provider failures), redacted details, and stack trace for errors.

> **Note:** Secret-like fields (`authorization`, `token`, `cookie`, `secret`,
> `password`, API keys) are **redacted** before writing.

---

## Compaction snapshots

When Octocode compacts the conversation context, it writes a Markdown summary to:

- **Timestamped snapshot:** `compaction/<timestamp>-<label>.md` — never overwritten; one file per compaction event.
- **Latest pointer:** `compaction/latest.md` — always the most recent snapshot.

Compaction snapshots are useful for understanding what the agent knew at a given point,
or recovering context after a session restart.

---

## Checkpoint pointer

The shadow-git checkpoint store intentionally lives **outside** the user repo to
avoid polluting version control:

```
~/.octocode/checkpoints/<cwd-hash>/
```

The session artifact tree contains a lightweight JSON pointer at `checkpoint-ref.json`:

```json
{ "storeDir": "/Users/you/.octocode/checkpoints/abc123/", "cwd": "/Users/you/myproject" }
```

This lets the session manifest track *that* checkpointing happened, without
moving the actual git objects.

---

## Fallback behaviour

Every route has a safe fallback for situations where the workspace doesn't yet
exist or the session context is absent (e.g., during early startup):

| Producer | Fallback path |
|----------|---------------|
| `plan` | `~/.octocode/tmp/plan/<scope-hash>/` |
| `browser` | `<workspace>/.octocode/screenshots/` (screenshots), `<workspace>/.octocode/chrome-debug/port-N/` (metadata) |
| `compaction` | `~/.octocode/tmp/compaction/sessions/<session-name>/` |
| `log` | `<workspace>/.octocode/logs/error.txt` |
| `image` | `<OS tmp>/octocode-images/<session-id>/` |

Fallback writes are never registered in the session manifest, so the manifest
always reflects only session-scoped artifacts.

---

## File security

- Directories: created with mode `0700` (owner read/write/execute only).
- Files: written with mode `0600` (owner read/write only).
- All writes use an atomic temp-file + rename pattern — no partial reads.
- Symlink escape is checked at each path boundary (traversal cannot escape the session root).
- The manifest is protected by a `O_EXCL` lock file during every update.

---

## Cleaning up

Session artifact trees accumulate over time. Each tree is small (a few KB to a
few MB depending on screenshot count). You can safely delete old session trees:

```sh
# List all session trees, sorted by age
ls -lt <workspace>/.octocode/agent/

# Remove trees older than 30 days
find <workspace>/.octocode/agent -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +

# Remove everything (nuclear — keeps the workspace clean)
rm -rf <workspace>/.octocode/agent/
```

> The `.octocode/agent/` directory itself can be added to `.gitignore` if you
> don't want session artifacts committed to version control.

---

## Internals (developer reference)

The session artifact system is implemented in:

| File | Role |
|------|------|
| `src/tools/session-artifacts.ts` | Core API: `createSessionArtifactContext`, `resolveSessionIdentity`, CAS projection, branch snapshots |
| `src/tools/active-plan.ts` | Exports `artifactContextForScope(scope)` — bridges plan scope → session identity |
| `src/tools/plan-html.ts` | Writes `plan/plan.html` + `plan/plan.md` via the artifact context |
| `src/chrome-debug.ts` | `getSessionDir(cwd, port, sessionKey?)` and `getScreenshotDir(cwd?, sessionKey?)` |
| `src/tools/chrome-debug-tool.ts` | Resolves `sessionKey` from `resolveSessionIdentity` and passes to `connectToChrome` |
| `src/tools/compaction-artifacts.ts` | `writeCompactionArtifact(details, session?, cwd?)` — session path when cwd+session provided |
| `src/tools/compaction-hooks.ts` | Passes `ctx.cwd` to `writeCompactionArtifact` |
| `src/tools/export-command.ts` | Registers `export/latest-ref.json` after writing the branded HTML export |
| `src/tools/create-image-tool.ts` | `persistFallbackPng` — writes to `images/` in session tree, falls back to OS tmp |
| `src/index.ts` | `getInternalErrorLogPath` returns `logs/error.txt` inside session tree; checkpoint ref registered on engine init |

### Adding a new producer

1. Add your producer name to `SessionArtifactProducer` in `session-artifacts.ts`.
2. Import `createSessionArtifactContext` (or `resolveSessionIdentity` for path-only) in your tool.
3. Call `ctx.writeText` / `ctx.writeJson` for the actual content.
4. Call `ctx.registerProducer('your-slot', 'relative/path.ext')` after the write.
5. Provide a fallback write path for when the session context is unavailable.
6. Add a test case to `tests/session-artifact-wiring.test.ts`.
