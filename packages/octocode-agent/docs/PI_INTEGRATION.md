# Historical Pi launcher integration

> Historical migration reference. Do not use this page for current launcher commands or
> architecture. Native `octocode-agent` neither imports nor launches Pi. The supported Pi
> path is the separate, small `@octocodeai/pi-extension` package.

## Purpose

This page records the former launcher-to-Pi boundary so migration reviews can identify
intentional differences. It does not define a native fallback or update path.

Current owners:

- Native launcher behavior: [`packages/octocode-agent`](../README.md) and
  `packages/octocode-agent/src/launcher.ts`.
- Native prompt behavior: [`HEADLESS.md`](HEADLESS.md) and
  `packages/octocode-agent/src/native-prompt.ts`.
- Pi extension behavior: [`packages/octocode-pi-extension/README.md`](../../octocode-pi-extension/README.md).
- Native cutover and extension-isolation gates: [`DESIGN/LEFTOVERS.md`](../../../DESIGN/LEFTOVERS.md).

## Independent extension boundary

`@octocodeai/pi-extension` remains a supported Pi package independently of the native product. It adds
a short prompt section, guarded file tools, an MCP loader, web/browser tools, subagents, and
`askUser` on top of Pi's own tools. It is no longer part of any conformance corpus. Operators can install it in a Pi host independently of
`octocode-agent`.

The native product does not:

- depend on `@octocodeai/pi-extension` or `@earendil-works/pi-coding-agent`;
- embed the Pi SDK;
- spawn a Pi subprocess;
- fall back to Pi after a native failure;
- accept Pi-compatible arguments as its command contract; or
- update the Pi extension through the native launcher.

`octocode-agent update platform` replaces the launcher and its bundled agent core
together. The removal RFC evidence owns Pi-extension versions and host matrices;
the launcher package does not.

## Historical comparison surfaces

These former Pi-host surfaces map to their native owners:

| Pi-host surface | Native owner |
|---|---|
| Pi turn and provider loop | `@octocodeai/agent-core` runtime plus native model transport |
| Pi session manager and JSONL | Native transactional session store and migration adapters |
| Pi interactive mode and extension UI | Native OpenTUI adapter |
| Pi prompt assembly and context files | Shared prompt builder plus native hierarchical instructions |
| Pi extension tools and policies | Native tool catalog, runtime policy, plan, approval, and trust composition |
| Pi extension lifecycle events | Agent-core lifecycle |

## Isolation rule

The Pi extension remains separately installable and supported.
The native launcher has no `pi|shadow|native` user-facing selector and must not depend on,
install, update, select, or fall back to the extension. Native release gates prove this
absence across source, manifests, dependency trees, built and packed artifacts, installers,
updates, and rollback packages. The extension retains its own tests, README,
and publication path.
