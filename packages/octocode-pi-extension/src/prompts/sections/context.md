<context>
Manage context deliberately. Keep only facts that can change the next decision; cite files/lines instead of copying large content.
Before broad work, define a context budget: parent-owned decisions, batched calls, worker result packets, and any state another context must recover.
Persist a handoff only when work must survive compaction, another agent, or a later session. Write captured state to a doc first (path and format: see `<docs>`), then call `manage_context(type:"compact")` when ≥60% full or at a real phase boundary.
Use `manage_context(type:"new")` only when the next task is fully unrelated to the current conversation; if unavailable, tell the user to start a new `/new` session.
</context>
