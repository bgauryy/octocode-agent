# Shared Awareness Flow

Use `npx @octocodeai/octocode-awareness`. Host tools and hooks may perform the same operations through the package API. The table below is the shared plane: prefix families with `coordination` unless a direct shortcut is shown. Run `coordination schema commands` for exact flags.

| Trigger | Action | Expected output / close |
|---|---|---|
| Resume shared work | direct `status`; relevant `coordination plan list`, `coordination task list`, direct `message read`, direct `handoff list` | Read-only counts/entities; inspect only decision-changing rows. |
| Take a ready task | `coordination task ready`, then `coordination task claim` | Claimed task with `agentId` and `leaseExpiresAt`; heartbeat if long-running. |
| Declare edits | `coordination work start` / `touch` | Advisory `WorkPresence`; `work end` returns `{ ended }`. |
| Protect unsafe overlap | `coordination lock acquire`; on conflict wait or message the holder | Lock or structured conflict; release explicitly. Expiry is not success. |
| Coordinate | direct `message send/read/list`; direct `handoff add/list/clear` | Durable message/receipt or continuation note. |
| Finish | `coordination task done`, run declared check, direct `check mark`, direct `check audit`, `coordination plan done` | `task done` returns `next: check.mark`; successful receipt returns `plan.done` only when eligible. |
| Reuse learning | `coordination memory recall`; after verification, `coordination memory store-verified` | Ranked leads or stored memory entity; recheck current source/tests. |
| Cleanup | `coordination lock/message/memory prune` | Dry-run counts first; delete only with explicit confirmation. |

All reads are observational. Expired leases are filtered or projected as available; explicit mutation commands reclaim or prune stored rows.
