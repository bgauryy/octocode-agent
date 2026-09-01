import fs from "node:fs";
import path from "node:path";

import {
  ToolRegistry,
  type ModelPort,
  type RuntimeEvent,
} from "@octocodeai/agent-core";
import {
  createDefaultNativeRuntime,
  parseNativeArgs,
} from "../../../octocode-agent/src/native-launcher.js";
import type { ProductionScenarioProbe } from "../../src/production-host-adapters.js";

const INITIAL_INPUT = "initial";
const STEER_INPUT = "steer-message";
const FOLLOW_UP_INPUT = "follow-up-message";

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function userTexts(
  messages: Parameters<ModelPort["run"]>[0]["messages"],
): string[] {
  return messages.flatMap((message) =>
    message.role === "user" ? [message.content] : [],
  );
}

async function waitUntilReady(
  snapshot: () => { readonly state: string },
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (snapshot().state !== "ready") {
    if (Date.now() >= deadline)
      throw new Error(
        `Native steer/follow-up runtime did not return to ready; state=${snapshot().state}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Drives steering and follow-up through createDefaultNativeRuntime. This is a
 * production-composition probe, not a built-CLI subprocess probe.
 */
export function createNativeSteerFollowUpProbe(
  root: string,
): ProductionScenarioProbe {
  return async ({ scenario, signal }) => {
    if (scenario.id !== "steer-and-follow-up")
      throw new Error(`Unexpected native control scenario: ${scenario.id}`);
    if (signal.aborted) throw signal.reason;

    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const providerInputs: string[][] = [];
    let firstRequestStarted!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    let thirdRequestStarted!: () => void;
    const thirdRequest = new Promise<void>((resolve) => {
      thirdRequestStarted = resolve;
    });
    const model: ModelPort = {
      run: async (request, context) => {
        providerInputs.push(userTexts(request.messages));
        const text = ["first", "steered", "followed"][providerInputs.length - 1];
        if (text !== undefined)
          await context.emit?.({ type: "text", text });
        if (providerInputs.length === 1) {
          firstRequestStarted();
          await waitForAbort(context.signal);
          return {
            stop: "cancelled",
            usage: { inputTokens: 1, outputTokens: 0 },
          };
        }
        if (providerInputs.length === 3) thirdRequestStarted();
        return {
          stop: "complete",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const runtime = await createDefaultNativeRuntime({
      env: {
        OCTOCODE_HOME: home,
        OCTOCODE_AGENT_ID: "production-native-steer-followup",
      },
      cwd: root,
      args: parseNativeArgs(["--mode", "json", "--no-session"]),
      model,
      tools: new ToolRegistry(),
    });
    const runtimeEvents: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => runtimeEvents.push(event));
    let running: Promise<void> | undefined;
    try {
      await runtime.start();
      running = runtime.submit(INITIAL_INPUT);
      await firstRequest;

      const steered = await runtime.execute({
        type: "input.steer",
        text: STEER_INPUT,
      });
      const followed = await runtime.execute({
        type: "input.follow-up",
        text: FOLLOW_UP_INPUT,
      });
      if (!steered.ok || !followed.ok)
        throw new Error(
          `Native controls were rejected: steer=${steered.ok} followUp=${followed.ok}`,
        );

      await running;
      await thirdRequest;
      await waitUntilReady(() => runtime.snapshot());

      const queued = runtimeEvents.filter(
        (event) => event.type === "input.queued",
      );
      const queuedKinds = queued.map(
        (event) => (event.payload as { readonly kind?: unknown }).kind,
      );
      const lastUserInputs = providerInputs.map((inputs) => inputs.at(-1));
      const expectedLastInputs = [INITIAL_INPUT, STEER_INPUT, FOLLOW_UP_INPUT];
      const streamedText = runtimeEvents.flatMap((event) => {
        if (event.type !== "message.delta") return [];
        const payload = event.payload as { readonly type?: unknown; readonly text?: unknown };
        return payload.type === "text" && typeof payload.text === "string"
          ? [payload.text]
          : [];
      });
      if (
        queued.length !== 2 ||
        queuedKinds[0] !== "steer" ||
        queuedKinds[1] !== "follow-up" ||
        providerInputs.length !== 3 ||
        expectedLastInputs.some(
          (expected, index) => lastUserInputs[index] !== expected,
        ) ||
        JSON.stringify(streamedText) !==
          JSON.stringify(["first", "steered", "followed"]) ||
        runtime.snapshot().state !== "ready"
      ) {
        throw new Error(
          `Native control proof failed: queued=${queuedKinds.join(",")} providerInputs=${JSON.stringify(providerInputs)} state=${runtime.snapshot().state}`,
        );
      }

      return {
        source: "native-production-composition" as const,
        events: [
          { kind: "turn.started" },
          { kind: "stream.text", data: { delta: "first" } },
          { kind: "stream.text", data: { delta: "steered" } },
          { kind: "stream.text", data: { delta: "followed" } },
          { kind: "turn.completed" },
          {
            kind: "control.queued",
            data: { steering: 1, followUp: 1 },
          },
          {
            kind: "control.delivered",
            data: {
              providerTurns: providerInputs.length,
              inputs: providerInputs,
            },
          },
        ],
        effects: [],
        observations: [
          {
            kind: "native.control-proof",
            data: {
              composition: "createDefaultNativeRuntime",
              queuedKinds,
              lastUserInputs,
              ready: true,
            },
          },
        ],
      };
    } finally {
      unsubscribe();
      if (running !== undefined) await runtime.cancel("probe teardown");
      await runtime.stop();
    }
  };
}
