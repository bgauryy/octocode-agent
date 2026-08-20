# Learning in Pi with Awareness Lite

Awareness Lite does not include the full `reflect` workflow. Use the published
Lite CLI for small, explicit memory notes, and keep larger improvement proposals
in normal docs, issues, or reviewed plans.

## When to record memory

Record only reusable, verified facts:

- a root cause or workaround that is likely to recur;
- a repository convention that changed the implementation path;
- a decision and the evidence behind it;
- a command or test gotcha future agents will need.

Skip routine status, raw logs, obvious edits, secrets, and facts already
authoritative in source/docs.

## Recall before risky work

```bash
npx @octocodeai/octocode-awareness-lite memory recall \
  --workspace "$PWD" --query "tokenization"
```

Treat every result as a lead. Re-read cited source and rerun current checks when
the fact can affect a change.

## Store a verified learning

```bash
npx @octocodeai/octocode-awareness-lite memory store \
  --workspace "$PWD" --label DECISION \
  --text "parser validation: malformed escapes are rejected before tokenization"
```

Keep the text short and cite source/test evidence in the wording when useful.
Do not use memory as a task queue; use `plan`/`task` for work and `handoff` for
continuation notes.

## Cleanup

Awareness Lite cleanup is explicit and item-scoped:

```bash
npx @octocodeai/octocode-awareness-lite status --workspace "$PWD"
npx @octocodeai/octocode-awareness-lite memory forget \
  --workspace "$PWD" --memory-id mem_123
```

Review state before any mutation. Lite has no reflection export, weakness mining,
wiki sync, or automated harness proposal flow; use the full Awareness package
only when those features are intentionally installed.
