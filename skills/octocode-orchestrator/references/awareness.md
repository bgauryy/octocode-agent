# Awareness Coordination

Load when shared repository state could change EXECUTE or VERIFY. Why: plans, peers, overlap, locks, messages, verification debt, recovery, or reusable learning must survive beyond one worker's context.

If `octocode-awareness` is available, inspect its live schema and use its normal loop: notice relevant shared state, declare bounded work and paths, coordinate only actionable overlap, record observed checks, close the run, and reflect verified reusable learning.

## Use it for

- concurrent editors or sessions touching related paths;
- shared plans/tasks, ownership, handoffs, inbox messages, or recovery;
- non-mergeable state requiring an exclusive lock;
- verification debt or durable memory that changes the plan.

Skip it for routine solo work with no shared-state signal. Ordinary overlap is advisory; use a lock only when simultaneous mutation is unsafe. Do not hand-edit generated coordination databases or duplicate host-projected presence/status calls.

If Awareness is unavailable, preserve the same safety contract locally: inventory active work when possible, assign disjoint paths, keep the parent as integration owner, and report the missing coordination evidence.

Next: return to [delegation](delegation.md) while workers are live, or load [completion](completion.md) to verify and close.
