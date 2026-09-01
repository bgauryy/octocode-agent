# Pi extension architecture

`@octocodeai/pi-extension` is the supported adapter for Pi `0.84.2`. It is a
sibling of the native host: both depend inward on `@octocodeai/agent-core`, and
neither imports the other.

## Ownership

- `src/index.ts` is the Pi composition root. It validates the supported host,
  wires lifecycle and UI hooks, registers Pi-facing tools and commands, and
  owns ordered disposal.
- `src/adapters/` translates Pi lifecycle, registries, settings, hooks, and
  plugins into core contracts without moving Pi types into core. It also owns
  real Pi SDK probes used by cross-host conformance, so the testing package does
  not acquire a Pi dependency.
- `src/tools/` owns Pi-only tool presentation, approval, browser/media helpers,
  plan UI, and compatibility registration. Its skill facade composes Pi session
  metadata with `@octocodeai/octocode-shared` canonical skill sources and
  inventory scanning; Pi does not implement a second filesystem scanner.
- `src/prompt.ts` and `src/prompts/` compose Pi-specific context around shared
  prompt fragments from `@octocodeai/octocode-shared`.
- `scripts/build.mjs` packages the extension, CLIs, themes, docs, and canonical
  Awareness skill assets. Generated `dist/` content is not a source tree.

## Lifecycle and registry flows

```text
Pi SDK callback
  -> adapters/pi-lifecycle-adapter
  -> canonical event name and translated payload
  -> core LifecycleBus
  -> reviewed hooks and normalized receipts

extension registration
  -> createPiCanonicalRegistryComposition
  -> canonical tool or command registry
  -> Pi-facing registration projection
  -> registration receipt

Pi skill metadata + shared source descriptors + bundled source
  -> shared discoverAgentSkillInventory containment/size/symlink validation
  -> Pi precedence and persisted enablement projection
  -> list metadata or load one validated SKILL.md
```

Pi SDK types and UI state remain inside this package. Lifecycle adapters map Pi
events to core semantics before dispatch; they must not label raw Pi payloads as
canonical. Shared prompt fragments come from `@octocodeai/octocode-shared`, while
Pi resource discovery and presentation remain adapter-local.

## Dependency rules

- Do not import native launcher, native OpenTUI, native sessions, or native
  transports.
- This package is the monorepo's only allowed owner of `@earendil-works/pi-*`
  dependencies and executable imports.
- Keep product policy, effect ordering, settings semantics, and canonical
  lifecycle contracts in core.
- Keep exact Octocode tool schemas in the external catalog; documentation and
  Pi adapters route to that authority instead of redefining schemas.
- Treat direct Pi registration as compatibility code. Shared production
  registrations must converge on the canonical registry adapters.

## Known convergence work

Production wraps the real Pi instance with `createPiCanonicalRegistryComposition`.
Tool and command registrations pass through canonical registries before their Pi
projection. The adapter still synthesizes conservative policy for Pi tools that
don't declare canonical effects, and command execution without Pi host context
returns unsupported. Production parity still requires exact settings, effects,
event payloads, and receipts to match native rather than only sharing registry
shape.

See [the package documentation index](docs/README.md) and the
[completion ledger](../../DESIGN/LEFTOVERS.md).
