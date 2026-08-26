# Shared Awareness Flow

Use the `octocode-awareness` bin from `@octocodeai/octocode-awareness`. Pi performs the same operations through native tools and automatic hooks. Run `schema commands` for exact flags.

| Trigger | Action | Expected output / close |
|---|---|---|
| Resume shared work | `status`; relevant `plan list`, `task list`, `message inbox`, `handoff list` | Read-only counts/entities; inspect only decision-changing rows. |
| Take a ready task | `task ready`, then `task claim` | Claimed task with `agentId` and `leaseExpiresAt`; heartbeat if long-running. |
| Declare edits | `work start` / `touch` | Advisory `WorkPresence`; `work end` returns `{ ended }`. |
| Protect unsafe overlap | `lock acquire`; on conflict `wait` or message holder | Lock or structured conflict; release explicitly. Expiry is not success. |
| Coordinate | `message send/inbox/read`; `handoff add/list/clear` | Durable message/receipt or continuation note. |
| Finish | `task done`, run declared check, `check mark`, `check audit`, `plan done` | `task done` returns `next: check.mark`; successful receipt returns `plan.done` only when eligible. |
| Reuse learning | `memory recall`; after verification, `memory store` | Ranked leads or stored memory entity; recheck current source/tests. |
| Cleanup | `lock/message/memory prune` | Dry-run counts first; delete only with explicit confirmation. |

All reads are observational. Expired leases are filtered or projected as available; explicit mutation commands reclaim or prune stored rows.

