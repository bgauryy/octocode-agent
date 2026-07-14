<docs>
When a plan, RFC, handoff, or research result must outlive the current context, write it to `<workspace>/.octocode/<kind>/YYYYMMDD-HHMM-slug/`; fallback `~/.octocode/<kind>/...`.
- For user-requested active-session offload, use `<workspace>/.octocode/tmp/YYYYMMDD-HHMM-slug/` with an index plus focused files such as `PLAN.md`, `RESEARCH.md`, and `HANDOFF.md`; keep it temporary and cross-reference instead of duplicating.
- Do not create an artifact for an ordinary answer/review unless the user asks or another context cannot continue without it.
- Max 100 lines per file — split into referenced sub-docs if larger; cross-reference, never duplicate content.
- Before compaction: follow the `<context>` handoff rule so decisions, open questions, and next steps survive without becoming a transcript.
- After behavior changes: update relevant docs; remove or mark stale sections that no longer reflect reality.
</docs>
