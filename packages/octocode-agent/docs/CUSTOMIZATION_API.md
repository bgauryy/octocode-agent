# Native customization API

Use the versioned native API to embed the Octocode agent while preserving the
same runtime, policy, durability, and controller semantics as the CLI.

Import runtime customization from `octocode-agent/api/v1`. Import the
renderer-neutral presentation contracts from
`octocode-agent/presentation/v1`. The package root remains a CLI package and does
not expose an unversioned library API.

## Compatibility contract

Version `v1` is a self-contained public contract. Its declarations do not require
applications to import native launcher internals, agent-core internals, OpenTUI,
or test packages. The CLI keeps the same command line and bin entrypoint.

`octocode-agent/api/v1` exports these primary contracts:

| Export | Purpose |
|---|---|
| `defineOctocodeAgentV1` | Validate and freeze an `OctocodeAgentCustomizationV1` descriptor. |
| `launchOctocodeAgentV1` | Launch the native composition with optional arguments, customization, environment, working directory, streams, version label, and `onControl` callback. |
| `AgentControlV1` | Submit input, cancel a turn, read a snapshot, subscribe to redacted runtime events, or stop the API-owned runtime. |
| `AgentControlSnapshotV1` | Read immutable runtime state, session, model, usage, active-turn, and revision data. |
| `AgentControlEventByTypeV1` | Receive a discriminated immutable runtime event whose event-specific projector removes sensitive payload fields and adds `dataClassification: "redacted"`. |
| `ProductPolicyOverlayV1` | Describe a prepend, append, or replace product-policy overlay. |
| `AgentToolV1` | Describe an additive tool and its executor. |
| `AgentHookV1` | Subscribe to a lifecycle event with the authority fixed for that event. |
| `AgentEventObserverV1` | Observe immutable, redacted lifecycle envelopes. |
| `AgentCompactionV1` | Customize the compaction summarizer or threshold. |
| `AgentPortableCustomizationV1` | Describe an integrity-bound ESM factory that the root and leaf workers can activate locally. |
| `AgentPortableCustomizationFactoryV1` | Type the factory export that recreates contributions in each process. |
| `AgentPresentationFactoryV1` | Create a renderer-neutral presentation port for an interactive run. |

The presentation subpath exports `AgentPresentationPortV1`,
`AgentPresentationEventV1`, `AgentPresentationInputEventV1`, and
`AgentPresentationFactoryContextV1`.

Define the customization once, then pass it to the launcher:

```ts
import {
  defineOctocodeAgentV1,
  launchOctocodeAgentV1,
} from "octocode-agent/api/v1";

const customization = defineOctocodeAgentV1({
  schemaVersion: 1,
  id: "example.application",
  productPolicyOverlay: {
    mode: "append",
    content: "Prefer the application's reviewed deployment workflow.",
  },
});

const exitCode = await launchOctocodeAgentV1({
  argv: ["Inspect the release candidate"],
  customization,
});
```

`launchOctocodeAgentV1` resolves to the native process exit code. Omitting
`customization` launches the same native composition used by the CLI.

## Runtime control

Use `onControl` to receive the launch-scoped `AgentControlV1`. The control is a
narrow adapter over the API-owned runtime:

```ts
import {
  launchOctocodeAgentV1,
  type AgentControlEventByTypeV1,
} from "octocode-agent/api/v1";

function processTelemetryEvent(event: AgentControlEventByTypeV1): void {
  switch (event.type) {
    case "tool.ended":
      console.log(event.payload.name, event.payload.outcome);
      break;
    default:
      break;
  }
}
let agentControl: import("octocode-agent/api/v1").AgentControlV1 | undefined;

await launchOctocodeAgentV1({
  onControl(control) {
    agentControl = control;
    control.subscribe((event) => {
      processTelemetryEvent(event);
    });
  },
});
```

`submit` sends user input through the normal runtime command path. `cancel`
cancels the active turn, `snapshot` returns immutable versioned state, and `stop`
requests orderly runtime shutdown. `subscribe` returns an unsubscribe function
for early removal. The launcher owns every remaining subscription and removes it
during teardown.

Control events are immutable, observe-only, discriminated by `type`, and
redacted through an exhaustive event-specific payload table. Their
`dataClassification` is `"redacted"`. A control subscriber cannot rewrite an
event, add context, stop a lifecycle transition, or make a permission decision.

Do not confuse the control event stream with lifecycle customization events:

- `control.subscribe` observes the API-owned runtime stream for application
  control and status projection.
- `customization.events` registers failure-isolated observers for selected
  lifecycle event types.
- `customization.hooks` registers decision-capable lifecycle contributions. The
  lifecycle event type fixes their authority.

All three surfaces use versioned contracts, but they have different ownership and
authority. Do not forward a control event into a hook as a substitute for the
lifecycle bus.

The API adapts contributions into the existing native composition root:

```text
v1 application configuration
  -> validation and contribution leases
  -> native launcher adapters
  -> agent-core runtime and durable services
  -> renderer-neutral presentation port
```

Do not import source files such as `native-launcher.ts`,
`presentation/contracts.ts`, registries, or OpenTUI modules. Those modules remain
implementation details and can change independently of the versioned API.

## Renderer contract

A custom renderer implements the port exported by
`octocode-agent/presentation/v1`. It receives renderer-neutral presentation
events and returns typed user intents. It doesn't receive OpenTUI widgets or
mutable runtime state.

The renderer owns:

- Presentation state derived from accepted presentation events.
- Native input collection and translation into the port's typed input intents.
- Accessible alternate output and cleanup of renderer-owned resources.

The native interactive controller continues to own:

- Active-turn state, input routing, slash commands, signals, and cancellation.
- Question workflow order and answer ledgers.
- Runtime-to-presentation projection and ordered teardown.

For example, an application can return a renderer port from its presentation
factory and keep framework-specific values inside that implementation:

```ts
import type {
  AgentPresentationEventV1,
  AgentPresentationFactoryContextV1,
  AgentPresentationFactoryV1,
} from "octocode-agent/presentation/v1";

declare function mountApplicationRenderer(context: AgentPresentationFactoryContextV1): void;
declare function renderApplicationEvent(event: AgentPresentationEventV1): void;
declare function unmountApplicationRenderer(): void;
declare function reduceWorkingState(
  state: "idle" | "active" | "cancelling" | "failed",
  event: AgentPresentationEventV1,
): "idle" | "active" | "cancelling" | "failed";

const presentation: AgentPresentationFactoryV1 = (context) => {
  let working: "idle" | "active" | "cancelling" | "failed" = "idle";
  return {
    inputOwnership: "external",
    async start() {
      mountApplicationRenderer(context);
    },
    accept(event) {
      working = reduceWorkingState(working, event);
      renderApplicationEvent(event);
    },
    snapshot: () => ({ working }),
    async stop() {
      unmountApplicationRenderer();
    },
  };
};
```

Use the installed `octocode-agent/presentation/v1` declarations for the factory
and port method signatures. Keep framework-specific values behind those
interfaces.

## Product-policy overlay

Configure a product-policy overlay with one of three modes:

| Mode | Result |
|---|---|
| `prepend` | Place the supplied text before the default product policy. |
| `append` | Place the supplied text after the default product policy. |
| `replace` | Replace the default product-policy component with the supplied text. |

All three modes preserve the runtime-context and repository-instruction
envelopes. In particular, `replace` does not replace repository instructions,
Awareness context, runtime safety context, or context artifacts.

The launcher resolves the overlay before it creates the durable prompt record.
The resolved product policy therefore participates in the prompt digest, resume
validation, provider cache identity, worker prompt identity, and post-compaction
stable prefix.

```ts
const productPolicyOverlay = {
  mode: "append",
  content: "Prefer the application's reviewed deployment workflow.",
} as const;
```

Use a stable, application-owned customization ID. Treat policy text as trusted
configuration; do not populate it directly from user input or retrieved content.

## Additive tools

Custom tools are additive. The API rejects duplicate tool names and doesn't
provide a way to replace the native default tool registry.

Every accepted tool enters the same core execution path as a native tool:

```text
input schema validation
  -> declared policy
  -> trust and approval
  -> effect admission
  -> bounded execution
  -> effect settlement
  -> ordered result
```

A tool declaration must accurately describe its input and output schemas,
effects, trust requirement, approval class, and plan behavior. Its executor must
honor the supplied cancellation signal. Trusted application code provides the
executor, but trust in the executor does not bypass runtime policy or the effect
ledger.

## Hooks and event observers

Hooks and event observers are separate surfaces.

Hooks subscribe to supported lifecycle events. Each event fixes the authorities
available to its hooks, such as observe, context contribution, rewrite, stop, or
allow/deny. A registration cannot request more authority than the event permits.
The lifecycle bus validates any rewrite or decision before it affects the
runtime. Hook envelopes carry `dataClassification: "sensitive"` because their
immutable payloads can contain the decision data that the hook needs. Keep these
payloads out of logs and external telemetry.

Hook and observer callbacks also receive a run-owned cancellation signal. The
host applies a bounded event-delivery timeout, cancels callbacks during shutdown,
stops new callback admission, and waits for a bounded teardown grace period.
Callbacks that remain pending are detached; their late rejection is consumed and
shutdown continues. Same-process JavaScript cannot be forcibly terminated, so a
detached callback can retain resources that it created itself. Callback
implementations must honor the signal.

Event observers receive immutable lifecycle envelopes projected through an
explicit operational field allowlist. Free-form messages, reasons, errors,
paths, prompts, inputs, outputs, and unknown nested values don't cross this
boundary. Their envelopes carry
`dataClassification: "redacted"`. Observers cannot rewrite payloads, add context,
stop a turn, or decide a permission request. An observer failure doesn't
interrupt runtime execution.

The data-classification field is part of the versioned contract. Applications
must still validate event types and payload fields before exporting them. Use the
redacted monitoring snapshot when an integration needs aggregated operational
telemetry instead of lifecycle delivery.

## Compaction customization

The API can customize the summary function and input-token threshold. It doesn't
expose the session store, compaction transaction, or live model history.

Custom compaction still runs through core's `DurableCompactionService`. The
service commits the compaction attempt and validated projection before the live
context changes. Resume reconstructs context from that committed projection, and
the stable system prompt remains message zero.

A summarizer must:

- Return the documented, bounded summary result.
- Respect cancellation signals and avoid hidden external effects.
- Treat model messages and artifacts as data, not as new system instructions.
- Produce sufficiently deterministic output for the application's audit and
  testing requirements.

If a summarizer throws, times out, returns an invalid result, or receives a
cancellation signal, the runtime keeps the pre-compaction live context and records
the failed attempt. It does not install a partial projection.

## Portable worker customization

Inline JavaScript functions are process-local. Use
`AgentPortableCustomizationV1` when selected tools, hooks, observers, or a custom
compaction summarizer must also run in leaf workers. Its entrypoint is an absolute
`file:` URL with an exact SHA-256 integrity value. The named ESM export receives
`{ schemaVersion: 1, target: "root" | "worker", config }` and returns the normal
function-bearing contribution set in that process.

`workerContributions` is an explicit selector list such as `tool:review`,
`hook:guard`, `event:audit`, or `compaction`. Worker tools are also intersected
with the capabilities delegated in the worker spawn packet. Presentation always
stays in the root process.

The root resolves the factory, computes a deterministic callback-free manifest,
and sends only the resolved descriptor through a closed, bounded bootstrap frame
on a dedicated inherited pipe. The frame is bound to the worker ID, correlation
ID, and prompt snapshot. The child verifies the entry-file hash and manifest
before composing its runtime. The customization digest participates in the
worker cache key. A data-only product-policy overlay uses the same bootstrap
transport and is no longer placed in an environment variable.

Direct inline runtime callbacks still fail closed with `--allow-workers`; use a
portable descriptor instead. This rule prevents these inconsistencies:

- A child advertises a custom tool but cannot execute it.
- Parent and child hooks enforce different decisions.
- A child computes a different stable prompt or compaction prefix.
- A root-only callback is silently omitted in a child process.

The host executes the exact verified entry bytes through a data URL. The module
must therefore be a self-contained ESM bundle: ordinary relative imports cannot
resolve from that URL. Treat code bundled into the entry file as trusted host
code.

Type the module export with the same public subpath:

```ts
import type {
  AgentToolV1,
  AgentPortableCustomizationFactoryV1,
} from "octocode-agent/api/v1";

declare function createReviewedTool(): AgentToolV1;

export const activate: AgentPortableCustomizationFactoryV1 = async ({
  target,
  config,
}) => ({
  schemaVersion: 1,
  id: "example.portable",
  productPolicyOverlay: {
    mode: "append",
    content: `Portable policy for ${target}: ${JSON.stringify(config)}`,
  },
  tools: [createReviewedTool()],
});
```

The embedding application points its descriptor at the bundled file and selects
the contributions that a child can receive:

```ts
const portable = {
  schemaVersion: 1,
  id: "example.portable",
  entrypoint: {
    kind: "module",
    moduleUrl: new URL("./portable-customization.mjs", import.meta.url).href,
    exportName: "activate",
    integrity: "sha256-<64 lowercase hexadecimal characters>",
  },
  config: { policyVersion: 3 },
  workerContributions: ["tool:review", "hook:guard", "compaction"],
} as const;
```

## Lifecycle and cleanup

The API leases every programmatic contribution to its owning run. Shutdown uses
this order:

1. Stop accepting new work and cancel the active turn when required.
2. Persist and settle runtime-owned state.
3. Stop lifecycle admission and apply the bounded callback-drain grace; drain
   presentation delivery.
4. Dispose hooks and event observers.
5. Dispose tool, compaction, renderer, and other run-owned resources.

The API makes customization disposal idempotent. It reports a cleanup failure, but
doesn't let another contribution overtake persistence-first teardown.

## Security and failure behavior

The API fails closed when it encounters:

- An unsupported contract version or invalid contribution.
- Duplicate tool names or malformed tool metadata.
- Hook authority that isn't valid for the selected event.
- A renderer that doesn't implement the complete presentation port.
- Direct inline runtime callbacks combined with `--allow-workers`.
- Portable module, manifest, selector, bootstrap-binding, or capability drift.
- Invalid compaction output or a broken durable compaction dependency.

Custom code runs in the application process and has that process's operating
system authority. The runtime limits what a custom tool can do through the agent
pipeline, but it cannot sandbox arbitrary code executed directly by a hook,
observer, summarizer, or renderer. Load contributions only from trusted
application code, bound their work, honor cancellation signals, and avoid blocking the
event loop.

## Resolved hardening items

The four previously rated `v1` leftovers are complete:

| Former gap | Resolution |
|---|---|
| Unbounded callback drain | Teardown stops admission, waits for a bounded grace period, detaches pending callbacks, and consumes late rejection. |
| Worker callback gap | Integrity-bound portable factories recreate explicitly selected tools, hooks, observers, and compaction callbacks in leaf workers. |
| `unknown` operational and lifecycle payloads | Control, sensitive-hook, and redacted-observer events publish discriminated event-specific payload maps. |
| 16 KiB environment transport | A closed 1 MiB file-descriptor (fd) bootstrap carries resolved portable descriptors or validated data-only prompt overlays. |

These constraints are deliberate and aren't backlog defects:

- The API treats programmatic callbacks as trusted in-process code, not as a sandbox for
  third-party extensions. Treating untrusted code as a customization has impact
  5 even though it is outside the supported threat model.
- Custom tools are additive and cannot replace native tools.
- Product-policy `replace` cannot remove runtime safety, repository instruction,
  Awareness, or durable context envelopes.
- Redacted events omit free-form and unknown nested fields by default. Expanding
  the allowlist requires a versioned privacy review and adversarial tests.

## Migration and rollout

Migrate integrations in this order:

1. Replace imports of native source files with the `api/v1` and
   `presentation/v1` subpaths.
2. Move terminal or framework state behind a custom presentation port.
3. Convert prompt replacement into an explicit product-policy overlay and verify
   that runtime and repository envelopes remain present.
4. Register tools additively and declare their complete policy and effect
   metadata.
5. Split decision-capable hooks from observe-only operational event handlers.
6. Move custom summary logic behind the compaction summarizer contract.
7. Bundle worker callbacks behind a portable ESM factory, pin its SHA-256, and
   select only the contributions that workers require.

Roll out one contribution family at a time. Record the default CLI trace first,
then compare prompt digests, effect receipts, lifecycle ordering, compaction
records, and alternate output after the application enables each contribution. Roll back by
removing the contribution; don't add compatibility shims around internal launcher
types.

## Verification

Test integrations at their owning boundaries:

| Boundary | Required evidence |
|---|---|
| Package API | A packed install can import both versioned subpaths, and a TypeScript consumer can type-check without repository-only packages. |
| Control | Tests cover submit, active-turn cancellation, immutable snapshots, redacted event delivery, early unsubscribe, launch-owned teardown, and orderly stop. |
| Renderer | Presentation contract tests cover event reduction, typed input intents, alternate output, cancellation, and disposal. |
| Product policy | Tests cover prepend, append, and replace; preserved runtime and repository envelopes; resume; worker digest parity; and compaction reconstruction. |
| Tools | Tests cover duplicate rejection, schema failure before effects, approval, effect receipts, cancellation, and ordered output. |
| Hooks and events | Tests cover every allowed authority, forbidden authority rejection, observer failure isolation, ordering, drain, and disposal. |
| Compaction | Tests cover threshold selection, valid summaries, invalid output, cancellation, commit-before-swap, and resume. |
| Workers | Tests prove direct callback configurations fail before startup; portable descriptors verify entry hash, manifest, selectors, capability intersection, bootstrap identity, cache identity, and product-policy prompt parity. |
| CLI | The built CLI help and representative native flows remain unchanged. |

For package ownership and layer diagrams, see
[Native agent architecture](../ARCHITECTURE.md). For the durable context and
permission invariants, see
[Permissions and context](PERMISSIONS_AND_CONTEXT.md). For leaf-worker semantics,
see [Parallelism and workers](PARALLELISM_AND_WORKERS.md). Release evidence belongs
in [Release validation](RELEASE_VALIDATION.md).
