import {
  ToolRegistry,
  createEffectSet,
  pluginId,
  revision,
  type PluginCapabilityGrant,
  type PluginManifest,
  type ToolDefinition,
} from "@octocodeai/agent-core";
import {
  NativeExtensionsController,
  type NativeDiscoveredPlugin,
} from "../../../octocode-agent/src/native-extensions.js";
import type { ProductionScenarioProbe } from "../../src/production-host-adapters.js";

function candidate(
  id: string,
  version = "1.0.0",
  hash = `${id}:${version}:hash`,
): NativeDiscoveredPlugin {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: pluginId(id),
    version,
    apiVersion: "1",
    activationEvents: ["onSessionStart"],
    permissions: ["tools.register"],
    contributions: [{ kind: "tool", path: "./activation-api" }],
  };
  const grant: PluginCapabilityGrant = {
    requested: ["tools.register"],
    granted: ["tools.register"],
    denied: [],
    revision: revision(`${id}:${version}:grant`),
  };
  return {
    manifest,
    grant,
    trust: "trusted",
    manifestHash: hash,
    reviewedHash: hash,
  };
}

function executableTool(
  value: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): ToolDefinition {
  return {
    name: "ignored-by-native-namespace",
    label: "Production plugin probe",
    description: "Executable programmatic plugin contribution for production conformance.",
    schemaVersion: 1,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object" },
    outputVersion: 1,
    policy: {
      effects: createEffectSet("read"),
      trust: "none",
      approval: "never",
      plan: "allowed",
    },
    execute: async () => ({
      ok: true,
      content: await value(),
      detailsVersion: 1,
    }),
  };
}

function callContext(callId: string): Parameters<ToolDefinition["execute"]>[0] {
  const signal = new AbortController().signal;
  return {
    input: {},
    callId: callId as never,
    context: {
      sessionId: "plugin-production-probe" as never,
      cwd: process.cwd(),
      mode: "headless",
      trust: { workspace: "trusted", managedOnly: false },
      signal,
    },
    signal,
    update: async () => undefined,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Drives the host-specific native plugin contract through the production
 * controller and real ToolRegistry.
 */
export function createNativePluginLifecycleProbe(_root: string): ProductionScenarioProbe {
  return async ({ scenario, signal }) => {
    if (scenario.id !== "plugin-lifecycle")
      throw new Error(`Unexpected native plugin scenario: ${scenario.id}`);
    signal.throwIfAborted();

    const lifecycle: string[] = [];
    const release = deferred();
    const entered = deferred();
    const first = candidate("first");
    const second = candidate("second");
    const third = candidate("third");
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [first, second, third],
      activatePlugin: async (plugin, writer) => {
        writer.addTool("run", executableTool(async () => {
          if (plugin.manifest.id === "first") {
            entered.resolve();
            await release.promise;
          }
          return { plugin: plugin.manifest.id, version: plugin.manifest.version };
        }));
      },
      onLifecycle: (event) => lifecycle.push(`${event.pluginId}:${event.state}`),
      now: () => 42,
    });
    await controller.discover();
    await controller.activate("first");
    await controller.activate("second");
    await controller.activate("third");
    const registry = new ToolRegistry();
    const registered = controller.registerTools(registry);
    const activeCall = registry.get("first:run")!.execute(callContext("plugin-call:first"));
    await entered.promise;
    let leaseBlockedDisable = false;
    try {
      controller.deactivate("first");
    } catch (error) {
      leaseBlockedDisable = error instanceof Error && /active lease/u.test(error.message);
    }
    release.resolve();
    const firstResult = await activeCall;
    controller.deactivate("first");
    const disabledToolRemoved = registry.get("first:run") === undefined;
    controller.deactivateAll();
    const reverseUnload = lifecycle
      .filter((entry) => entry.endsWith(":deactivating"))
      .slice(-2);
    const reverseUnloaded = JSON.stringify(reverseUnload) === JSON.stringify([
      "third:deactivating",
      "second:deactivating",
    ]);
    const unloaded = registry.list().length === 0 &&
      controller.snapshot().contributions.length === 0;

    const failureLifecycle: string[] = [];
    const broken = candidate("broken");
    const failed = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [broken],
      activatePlugin: async (_plugin, writer) => {
        writer.addTool("never", executableTool(() => ({ impossible: true })));
        throw new Error("production activation failure");
      },
      onLifecycle: (event) => failureLifecycle.push(`${event.pluginId}:${event.state}`),
    });
    await failed.discover();
    await failed.activate("broken").then(
      () => { throw new Error("Broken plugin unexpectedly activated"); },
      () => undefined,
    );
    const failureClosed = failed.snapshot().contributions.length === 0 &&
      failed.snapshot().plugins[0]?.lifecycle === "failed";

    const deniedCandidate = candidate("denied");
    let deniedActivationCalls = 0;
    const denied = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [{
        ...deniedCandidate,
        grant: {
          ...deniedCandidate.grant,
          granted: [],
          denied: ["tools.register"],
        },
      }],
      activatePlugin: async () => { deniedActivationCalls += 1; },
    });
    await denied.discover();
    const deniedResult = await denied.activateEligible();
    const deniedGrantClosed = deniedActivationCalls === 0 &&
      deniedResult.activated.length === 0 &&
      deniedResult.skipped.some(({ id, reason }) => id === "denied" && reason === "capabilities");

    const inert = candidate("inert");
    const declarative = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [inert],
      activatePlugin: async (_plugin, writer) => {
        writer.add({ kind: "tool", id: "inert:declared", value: { label: "No executor" } });
      },
    });
    await declarative.discover();
    await declarative.activate("inert");
    const inertRegistry = new ToolRegistry();
    let inertRejected = false;
    try {
      declarative.registerTools(inertRegistry);
    } catch (error) {
      inertRejected = error instanceof Error && /requires an executor/u.test(error.message);
    }
    inertRejected &&= inertRegistry.list().length === 0;

    const updatedCandidate = candidate("updated", "2.0.0");
    const activateUpdated = () => new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [updatedCandidate],
      activatePlugin: async (plugin, writer) => {
        writer.addTool("version", executableTool(() => ({ version: plugin.manifest.version })));
      },
    });
    const updated = activateUpdated();
    await updated.discover();
    const updateActivation = await updated.activateEligible();
    const updatedRegistry = new ToolRegistry();
    updated.registerTools(updatedRegistry);
    const updatedResult = await updatedRegistry.get("updated:version")!.execute(callContext("plugin-call:update"));
    updated.deactivateAll();
    const resumed = activateUpdated();
    await resumed.discover();
    const resumeActivation = await resumed.activateEligible();
    const resumedRegistry = new ToolRegistry();
    resumed.registerTools(resumedRegistry);
    const resumedResult = await resumedRegistry.get("updated:version")!.execute(callContext("plugin-call:resume"));
    resumed.deactivateAll();

    const updatedToV2 = updateActivation.activated.includes("updated") &&
      JSON.stringify(updatedResult).includes("2.0.0");
    const resumedV2 = resumeActivation.activated.includes("updated") &&
      JSON.stringify(resumedResult).includes("2.0.0");
    const ready = leaseBlockedDisable && disabledToolRemoved && unloaded && reverseUnloaded &&
      failureClosed && deniedGrantClosed && inertRejected && updatedToV2 && resumedV2;
    if (!ready) {
      throw new Error(`Native plugin lifecycle proof failed: ${JSON.stringify({
        leaseBlockedDisable,
        disabledToolRemoved,
        unloaded,
        reverseUnloaded,
        failureClosed,
        deniedGrantClosed,
        inertRejected,
        updatedToV2,
        resumedV2,
      })}`);
    }

    signal.throwIfAborted();
    return {
      source: "native-production-composition",
      events: [{
        kind: "plugin.lifecycle",
        data: {
          activated: true,
          used: firstResult.ok,
          disabled: disabledToolRemoved,
          unloaded,
          updated: updatedToV2,
          resumed: resumedV2,
        },
      }],
      effects: [{
        id: "plugin-lifecycle:tool-execution",
        kind: "plugin.tool-execution",
        effectful: false,
        data: { completed: true },
      }],
      observations: [
        {
          kind: "plugin.capability-grant",
          data: { requested: first.grant.requested, granted: first.grant.granted, denied: first.grant.denied },
        },
        {
          kind: "plugin.activation-leases",
          data: { blockedDisableWhileActive: leaseBlockedDisable, settledAfterCall: true },
        },
        {
          kind: "plugin.reverse-unload",
          data: { order: reverseUnload, reverseOrderVerified: reverseUnloaded, toolsRemoved: unloaded },
        },
        {
          kind: "plugin.failure-closure",
          data: {
            transactionRolledBack: failureClosed,
            deniedGrantPreventedActivation: deniedGrantClosed,
            inertDeclarativeRejected: inertRejected,
            lifecycle: failureLifecycle,
          },
        },
        {
          kind: "plugin.update-resume",
          data: { version: "2.0.0", updated: updatedToV2, resumed: resumedV2 },
        },
        {
          kind: "plugin.registry",
          data: { registered },
        },
      ],
    };
  };
}
