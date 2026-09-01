import type {
  CanonicalHostConformanceScenario,
  CanonicalScenarioId,
  HostConformanceAdapter,
  HostExecutionReceipt,
  HostExecutionContext,
  HostScenarioSupport,
} from "./host-conformance.js";

const INITIAL_PRODUCTION_SCENARIO = "lifecycle-clean-start-stop";
const PI_SDK_LIFECYCLE_EVIDENCE = "production-composition/pi-sdk-lifecycle";
const NATIVE_LIFECYCLE_EVIDENCE = "production-composition/native-lifecycle";
const PI_SDK_SCENARIO_EVIDENCE = "production-composition/pi-sdk-scenarios";
const NATIVE_SCENARIO_EVIDENCE = "production-composition/native-scenarios";

type RegistryKind = "tools" | "commands" | "hooks";
type RawHostRegistry = Readonly<Record<RegistryKind, readonly string[]>>;

function applicabilitySupport(
  scenario: CanonicalHostConformanceScenario,
  host: "pi" | "native",
): HostScenarioSupport | undefined {
  return scenario.applicability.kind === "host-specific" &&
    scenario.applicability.host !== host
    ? {
        supported: false,
        reason: `${scenario.id} is explicitly scoped to the ${scenario.applicability.host} host: ${scenario.applicability.reason}`,
      }
    : undefined;
}

function productionSupport(
  host: string,
  scenarioId: string,
  lifecycleSupported: boolean,
  probes: ProductionScenarioProbes,
  unsupportedReasons: ProductionScenarioUnsupportedReasons,
): HostScenarioSupport {
  return (scenarioId === INITIAL_PRODUCTION_SCENARIO && lifecycleSupported) ||
    typeof probes[scenarioId as CanonicalScenarioId] === "function"
    ? { supported: true }
    : {
        supported: false,
        reason:
          unsupportedReasons[scenarioId as CanonicalScenarioId] ??
          `${host} production composition has no executable ${scenarioId} probe`,
      };
}

export interface ProductionScenarioProbeInput {
  readonly scenario: CanonicalHostConformanceScenario;
  readonly signal: AbortSignal;
}

export type ProductionCompositionRoot =
  | "installed-pi-sdk"
  | "native-production-composition"
  | "built-native";

export interface ProductionScenarioReceipt {
  readonly source: ProductionCompositionRoot;
  readonly events: readonly {
    readonly kind: string;
    readonly data?: unknown;
  }[];
  readonly effects: readonly {
    readonly id: string;
    readonly kind: string;
    readonly effectful: boolean;
    readonly data?: unknown;
  }[];
  /**
   * Host-attributed implementation evidence retained verbatim in the report.
   * Observations never participate in semantic parity hashes.
   */
  readonly observations?: readonly {
    readonly kind: string;
    readonly data?: unknown;
  }[];
}

export type ProductionScenarioProbe = (
  input: ProductionScenarioProbeInput,
) => ProductionScenarioReceipt | Promise<ProductionScenarioReceipt>;
export type ProductionScenarioProbes = Partial<
  Record<CanonicalScenarioId, ProductionScenarioProbe>
>;
export type ProductionScenarioUnsupportedReasons = Partial<
  Record<CanonicalScenarioId, string>
>;

function recordRegistryProjection(
  context: HostExecutionContext,
  registry: RawHostRegistry,
): void {
  const registered = (["tools", "commands", "hooks"] as const).filter(
    (kind) => registry[kind].length > 0,
  );
  if (registered.length !== 3)
    throw new Error(
      `Production lifecycle did not register every canonical registry: ${registered.join(", ")}`,
    );
  const projection = { schemaVersion: 1, registered };
  context.emit("host.started");
  context.emit("registry.snapshot", projection);
  context.effect({
    id: `${INITIAL_PRODUCTION_SCENARIO}:registry`,
    kind: "registry.projection",
    effectful: false,
    data: projection,
  });
  context.emit("host.stopped");
}

export interface ProductionPiLifecycleCapture {
  readonly started: boolean;
  readonly stopped: boolean;
  readonly registry: RawHostRegistry;
}

function recordProductionReceipt(
  context: HostExecutionContext,
  receipt: ProductionScenarioReceipt,
  expectedSources: readonly ProductionCompositionRoot[],
): HostExecutionReceipt {
  if (!expectedSources.includes(receipt.source))
    throw new Error(
      `Production probe must report ${expectedSources.join(" or ")}; received ${receipt.source}`,
    );
  if (receipt.events.length === 0)
    throw new Error(
      `Production ${expectedSources.join(" or ")} probe returned no events`,
    );
  for (const event of receipt.events) context.emit(event.kind, event.data);
  for (const effect of receipt.effects) context.effect(effect);
  return {
    observations: [
      { kind: "production.probe-source", data: { source: receipt.source } },
      ...(receipt.observations ?? []),
    ],
  };
}

/** Accepts only receipts captured through the installed Pi SDK composition root. */
export function createProductionPiHostAdapter(options: {
  readonly hostVersion: string;
  readonly scenarioProbes?: ProductionScenarioProbes;
  readonly unsupportedReasons?: ProductionScenarioUnsupportedReasons;
  /** A receipt captured from Pi's installed SDK, never from a Pi-shaped harness. */
  readonly captureLifecycle?: () => Promise<ProductionPiLifecycleCapture>;
}): HostConformanceAdapter {
  const probes = options.scenarioProbes ?? {};
  const hasScenarioProbes = Object.keys(probes).length > 0;
  return {
    name: `pi@${options.hostVersion} [${
      hasScenarioProbes ? PI_SDK_SCENARIO_EVIDENCE : PI_SDK_LIFECYCLE_EVIDENCE
    }]`,
    evidence: "production",
    hostKind: "pi",
    supports: (scenario) =>
      applicabilitySupport(
        scenario as CanonicalHostConformanceScenario,
        "pi",
      ) ??
      productionSupport(
          "Pi",
          scenario.id,
          options.captureLifecycle !== undefined,
          probes,
          options.unsupportedReasons ?? {},
        ),
    async execute(scenario, context) {
      if (
        !productionSupport(
          "Pi",
          scenario.id,
          options.captureLifecycle !== undefined,
          probes,
          options.unsupportedReasons ?? {},
        ).supported
      )
        throw new Error(`Unsupported Pi scenario: ${scenario.id}`);
      if (
        scenario.id === INITIAL_PRODUCTION_SCENARIO &&
        options.captureLifecycle
      ) {
        const capture = await options.captureLifecycle();
        if (!capture.started || !capture.stopped)
          throw new Error(
            "Pi SDK lifecycle capture did not observe both session_start and session_shutdown",
          );
        recordRegistryProjection(context, capture.registry);
        return;
      }
      const probe = probes[scenario.id as CanonicalScenarioId];
      if (probe) {
        const receipt = await probe({
          scenario: scenario as CanonicalHostConformanceScenario,
          signal: context.signal,
        });
        return recordProductionReceipt(context, receipt, ["installed-pi-sdk"]);
      }
      throw new Error(`Unsupported Pi scenario: ${scenario.id}`);
    },
  };
}

export interface NativeProductionCapture {
  readonly events: readonly unknown[];
  readonly commandNames: readonly string[];
}

function nativeRegistry(capture: NativeProductionCapture): RawHostRegistry {
  const widget = capture.events.find((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event))
      return false;
    const value = event as {
      type?: unknown;
      property?: unknown;
      value?: { id?: unknown };
    };
    return (
      value.type === "presentation-changed" &&
      value.property === "widget" &&
      value.value?.id === "native-command-output"
    );
  }) as { value?: { items?: unknown } } | undefined;
  const items = Array.isArray(widget?.value?.items) ? widget.value.items : [];
  const eventTypes = capture.events.flatMap((event) =>
    typeof event === "object" &&
    event !== null &&
    !Array.isArray(event) &&
    typeof (event as { type?: unknown }).type === "string"
      ? [(event as { type: string }).type]
      : [],
  );
  return {
    tools: items,
    commands: [...capture.commandNames].sort(),
    hooks: eventTypes.filter(
      (type) => type === "runtime-ready" || type === "runtime-stopping",
    ),
  };
}

/** Accepts only receipts captured through the built native composition root. */
export function createProductionNativeHostAdapter(options: {
  readonly scenarioProbes?: ProductionScenarioProbes;
  readonly unsupportedReasons?: ProductionScenarioUnsupportedReasons;
  /** A receipt captured from the native production composition, never a no-op runtime. */
  readonly captureLifecycle?: () => Promise<NativeProductionCapture>;
}): HostConformanceAdapter {
  const probes = options.scenarioProbes ?? {};
  const hasScenarioProbes = Object.keys(probes).length > 0;
  return {
    name: `native [${
      hasScenarioProbes ? NATIVE_SCENARIO_EVIDENCE : NATIVE_LIFECYCLE_EVIDENCE
    }]`,
    evidence: "production",
    hostKind: "native",
    supports: (scenario) =>
      applicabilitySupport(
        scenario as CanonicalHostConformanceScenario,
        "native",
      ) ??
      productionSupport(
          "Native",
          scenario.id,
          options.captureLifecycle !== undefined,
          probes,
          options.unsupportedReasons ?? {},
        ),
    async execute(scenario, context) {
      if (
        !productionSupport(
          "Native",
          scenario.id,
          options.captureLifecycle !== undefined,
          probes,
          options.unsupportedReasons ?? {},
        ).supported
      )
        throw new Error(`Unsupported native scenario: ${scenario.id}`);
      if (
        scenario.id === INITIAL_PRODUCTION_SCENARIO &&
        options.captureLifecycle
      ) {
        const capture = await options.captureLifecycle();
        recordRegistryProjection(context, nativeRegistry(capture));
        return;
      }
      const probe = probes[scenario.id as CanonicalScenarioId];
      if (probe) {
        const receipt = await probe({
          scenario: scenario as CanonicalHostConformanceScenario,
          signal: context.signal,
        });
        return recordProductionReceipt(context, receipt, [
          "native-production-composition",
          "built-native",
        ]);
      }
      throw new Error(`Unsupported native scenario: ${scenario.id}`);
    },
  };
}
