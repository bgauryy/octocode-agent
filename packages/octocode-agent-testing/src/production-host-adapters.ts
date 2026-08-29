import type {
  CanonicalHostConformanceScenario,
  CanonicalScenarioId,
  HostConformanceAdapter,
  HostExecutionContext,
  HostScenarioSupport,
} from "./host-conformance.js";

const INITIAL_PRODUCTION_SCENARIO = "lifecycle-clean-start-stop";

function productionSupport(
  host: string,
  scenarioId: string,
  drivers: ProductionScenarioDrivers<unknown>,
): HostScenarioSupport {
  return scenarioId === INITIAL_PRODUCTION_SCENARIO ||
    typeof drivers[scenarioId as CanonicalScenarioId] === "function"
    ? { supported: true }
    : {
        supported: false,
        reason: `${host} production adapter has not implemented ${scenarioId}`,
      };
}

export interface ProductionScenarioDriverInput<TSurface> {
  readonly scenario: CanonicalHostConformanceScenario;
  readonly context: HostExecutionContext;
  readonly surface: TSurface;
}

export type ProductionScenarioDriver<TSurface> = (
  input: ProductionScenarioDriverInput<TSurface>,
) => void | Promise<void>;
export type ProductionScenarioDrivers<TSurface> = Partial<
  Record<CanonicalScenarioId, ProductionScenarioDriver<TSurface>>
>;

function recordRegistryProjection(
  context: HostExecutionContext,
  registry: Readonly<Record<string, unknown>>,
): void {
  context.emit("host.started");
  context.emit("registry.snapshot", registry);
  context.effect({
    id: `${INITIAL_PRODUCTION_SCENARIO}:registry`,
    kind: "registry.projection",
    effectful: false,
    data: registry,
  });
  context.emit("host.stopped");
}

export interface ProductionPiHarness<TPi> {
  readonly pi: TPi;
  readonly tools: ReadonlyMap<string, unknown>;
  readonly commands: ReadonlyMap<string, unknown>;
  readonly handlers: ReadonlyMap<string, readonly unknown[]>;
  emit(event: string, data: unknown): Promise<unknown>;
}

/** Runs the actual supported Pi extension factory against a structural Pi host. */
export function createProductionPiHostAdapter<TPi>(options: {
  readonly hostVersion: string;
  readonly createHarness: () => ProductionPiHarness<TPi>;
  readonly activate: (pi: TPi) => Promise<void>;
  readonly scenarioDrivers?: ProductionScenarioDrivers<
    ProductionPiHarness<TPi>
  >;
}): HostConformanceAdapter {
  const drivers = options.scenarioDrivers ?? {};
  return {
    name: `pi@${options.hostVersion}`,
    evidence: "production",
    supports: (scenario) =>
      productionSupport(
        "Pi",
        scenario.id,
        drivers as ProductionScenarioDrivers<unknown>,
      ),
    async execute(scenario, context) {
      if (
        !productionSupport(
          "Pi",
          scenario.id,
          drivers as ProductionScenarioDrivers<unknown>,
        ).supported
      )
        throw new Error(`Unsupported Pi scenario: ${scenario.id}`);
      const harness = options.createHarness();
      await options.activate(harness.pi);
      const driver = drivers[scenario.id as CanonicalScenarioId];
      if (driver) {
        await driver({
          scenario: scenario as CanonicalHostConformanceScenario,
          context,
          surface: harness,
        });
        await harness.emit("session_shutdown", { reason: "quit" });
        return;
      }
      const registry = {
        tools: [...harness.tools.keys()].sort(),
        commands: [...harness.commands.keys()].sort(),
        hooks: [...harness.handlers.keys()].sort(),
      };
      await harness.emit("session_shutdown", { reason: "quit" });
      recordRegistryProjection(context, registry);
    },
  };
}

export interface NativeProductionCapture {
  readonly events: readonly unknown[];
  readonly commandNames: readonly string[];
}

function nativeRegistry(
  capture: NativeProductionCapture,
): Readonly<Record<string, unknown>> {
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

/** Runs the actual native launcher and observes its production `/tools` and lifecycle projections. */
export function createProductionNativeHostAdapter<TDependencies>(options: {
  readonly launch: (
    argv: readonly string[],
    dependencies: TDependencies,
  ) => Promise<number>;
  readonly createDependencies: (events: unknown[]) => TDependencies;
  readonly commandNames: readonly string[];
  readonly scenarioDrivers?: ProductionScenarioDrivers<NativeProductionCapture>;
}): HostConformanceAdapter {
  const drivers = options.scenarioDrivers ?? {};
  return {
    name: "native",
    evidence: "production",
    supports: (scenario) =>
      productionSupport(
        "Native",
        scenario.id,
        drivers as ProductionScenarioDrivers<unknown>,
      ),
    async execute(scenario, context) {
      if (
        !productionSupport(
          "Native",
          scenario.id,
          drivers as ProductionScenarioDrivers<unknown>,
        ).supported
      )
        throw new Error(`Unsupported native scenario: ${scenario.id}`);
      const events: unknown[] = [];
      const exitCode = await options.launch(
        [],
        options.createDependencies(events),
      );
      if (exitCode !== 0)
        throw new Error(`Native production launcher exited with ${exitCode}`);
      const capture = { events, commandNames: options.commandNames };
      const driver = drivers[scenario.id as CanonicalScenarioId];
      if (driver) {
        await driver({
          scenario: scenario as CanonicalHostConformanceScenario,
          context,
          surface: capture,
        });
        return;
      }
      recordRegistryProjection(context, nativeRegistry(capture));
    },
  };
}
