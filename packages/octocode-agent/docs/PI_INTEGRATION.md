# Historical Pi launcher integration

> Historical migration reference. Do not use this page for current launcher commands or
> architecture. Native `octocode-agent` neither imports nor launches Pi. The supported Pi
> path is the separate `@octocodeai/pi-extension` parity oracle.

## Purpose

This page records the former launcher-to-Pi boundary so parity tests and migration reviews
can identify intentional differences. It does not define a production fallback, update
path, or permanent compatibility promise.

Current owners:

- Native launcher behavior: [`packages/octocode-agent`](../README.md) and
  `packages/octocode-agent/src/launcher.ts`.
- Native prompt behavior: [`HEADLESS.md`](HEADLESS.md) and
  `packages/octocode-agent/src/native-prompt.ts`.
- Pi adapter behavior: [`packages/octocode-pi-extension/docs`](../../octocode-pi-extension/docs/README.md).
- Cutover and deletion gates: [`DESIGN/pi-coding-agent-removal`](../../../DESIGN/pi-coding-agent-removal/README.md).

## Frozen oracle boundary

During migration, `@octocodeai/pi-extension` remains a supported Pi package. It supplies
the Pi-specific prompt adapter, tools, skills, UI, and Awareness lifecycle wiring used by
the parity corpus. Operators can install it in a Pi host independently of
`octocode-agent`.

The native product does not:

- depend on `@octocodeai/pi-extension` or `@earendil-works/pi-coding-agent`;
- embed the Pi SDK;
- spawn a Pi subprocess;
- fall back to Pi after a native failure;
- accept Pi-compatible arguments as its command contract; or
- update the Pi adapter through `octocode-agent update core`.

The native `update core` command targets `@octocodeai/agent-core`. The removal RFC evidence
owns Pi-oracle versions and host matrices; the launcher package does not.

## Historical comparison surfaces

Parity work can compare these former Pi-host surfaces with their native owners:

| Pi-host surface | Native owner |
|---|---|
| Pi turn and provider loop | `@octocodeai/agent-core` runtime plus native model transport |
| Pi session manager and JSONL | Native transactional session store and migration adapters |
| Pi interactive mode and extension UI | Native OpenTUI adapter |
| Pi prompt assembly and context files | Shared prompt builder plus native hierarchical instructions |
| Pi extension tools and policies | Native tool catalog, runtime policy, plan, approval, and trust composition |
| Pi extension lifecycle events | Agent-core lifecycle plus native Awareness adapter |

Use the shared conformance corpus and effect ledger to compare behavior. A passing unit test
or structural similarity is not a cutover receipt.

## Retirement rule

Pi remains a separately installable supported adapter and executable parity oracle until
the native-only release, rollback, migration, and real-host conformance gates pass. The
native launcher has no implemented `pi|shadow|native` release selector today; that selector
is gated migration work, not a current user-facing toggle. After the gates pass, delete the
Pi package and its product path. Do not preserve a hidden launcher fallback.
