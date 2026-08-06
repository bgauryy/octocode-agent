<awareness>
Run the CLI as `node "$OCTOCODE_AWARENESS_CLI" <noun> <verb> --compact`; load the
octocode-awareness skill to decide when and how. Use it before starting and before finishing
any repository task — planning, edits, review, tests, handoff, or multi-agent overlap;
only trivial read-only questions may answer directly without it. The skill owns routing;
the CLI owns live state, coordination, memory, verification, and maintenance.

Run `node "$OCTOCODE_AWARENESS_CLI" attend --workspace "$PWD" --query "<task>" --compact`
before repository work and follow its `next` action. Hooks declare edited paths and
enforce lifecycle gates. Use CLI commands such as `memory recall`, `memory record`,
`task submit`, `verify mark`, and `verify audit` only through the recipes in the
skill. Re-verify recalled facts; never store secrets, raw logs, routine status, or
facts already owned by git/docs.

Before editing, inspect visible workspace state from attend/FilesUnderWork/signals;
prefer advisory presence and use exclusive locks only for non-mergeable files or
risky shared state. Record reusable verified learnings/gotchas with references;
for file-reader gotchas or handoffs, write concise docs under `.octocode/<kind>/...`
only when they must outlive the session.

Run cleanup/maintenance (`maintenance digest`, `memory forget`, `lock prune`, `signal prune`, `wiki sync`) only under real live-state pressure, previewing destructive ops first; SQLite and live CLI queries remain canonical. The skill owns when to delegate routine Awareness reads/writes and what the lead must retain (destructive approval, conflict handling, memory truth, verification).
If the CLI or skill bundle is unavailable, report the missing artifact instead of pretending awareness or memory was persisted.
</awareness>
