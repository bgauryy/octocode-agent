<context>
Manage context deliberately. Keep only facts that can change the next decision; cite files/lines instead of copying large content.
Before broad work, define a context budget: parent-owned decisions, batched calls, worker result packets, and any state another context must recover.
If context was compacted or summarized while work continues, treat it as the same logical task: continue from the summary, preserve completed decisions, and do not restart finished work.
Pi compaction is lossy: it summarizes older turns, keeps recent messages, reloads as `summary + kept messages`, and may omit details not captured in the summary. Do not assume stale file, worker, lock, or verification state survived unchanged.
`manage_context(type:"compact")` wraps Pi's native compaction (`ctx.compact()` / `/compact`), adds continuation-focused summary instructions, and queues a follow-up only after `onComplete` so the agent resumes after the saved summary. Do not send a separate plain "continue".
If the model hits a maximum output token limit, do not use plain "continue" or compaction as the main fix; switch to concise/chunked output, or write long content to a file and return only a path plus short summary.
When context can be saved for future you or other agents, offload a concise `SUMMARY-{{title}}.md` beside the active handoff instead of carrying transcript text.
Persist a handoff only when work must survive compaction, another agent, or a later session. Store it at `<workspace>/.octocode/tmp/YYYYMMDD-HHMM-slug/HANDOFF.md` for active-session resume, `<workspace>/.octocode/tmp/YYYYMMDD-HHMM-slug/SUMMARY-{{title}}.md` for context offload, `<workspace>/.octocode/plans/.../PLAN.md` for planning, or Awareness memory only for verified reusable lessons. Read the handoff/summary back, then call `manage_context(type:"compact")` when ≥60% full or at a real phase boundary. Prefer a handoff over compaction when starting a focused new session/thread because handoff is explicit and reviewable while compaction is lossy.

**Compact handoff structure (concise markdown, not raw transcript):**
- `state` — why compacting now, current mode, confidence, and any user sentiment/preference that changes the next action.
- `context` — goal, constraints, decisions made, files/commands touched, and decisive evidence anchors.
- `leftovers` — blockers, open questions, incomplete tool pages/cursors, live workers/locks, approval gates, errors, recovery paths.
- `plan/task` — current task status, completed items, next 1-3 dependent steps, verification still owed.
- `pickup` — exact file, command, tool call, worker message, or user question to resume from.

**After compaction:** read the summary/handoff first, run Awareness `attend` for live state when in a repo, list/status live workers when any were active, re-check stale file/lock/verification assumptions, resume at `pickup`, and do not redo completed work. If `pickup` is missing or stale, reconstruct it from decisive anchors before acting; do not restart broadly. If compaction revealed a verified reusable gotcha, record it through Awareness memory or `.octocode/<kind>/...`; otherwise delete/ignore routine temporary notes when done.
Use `manage_context(type:"new")` only when the next task is fully unrelated to the current conversation; if unavailable, tell the user to start a new `/new` session.
</context>
