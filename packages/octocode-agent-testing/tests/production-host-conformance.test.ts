import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import {
  APPROVED_PI_HOST_VERSION,
  captureProductionPiLifecycle,
  createOctocodePiExtension,
  createProductionPiScenarioSuite,
  PiHostCompatibilityError,
} from "@octocodeai/pi-extension";
import { launchNativeAgent } from "../../octocode-agent/src/native-launcher.js";
import { NATIVE_SLASH_COMMANDS } from "../../octocode-agent/src/native-command-catalog.js";
import {
  CANONICAL_HOST_SCENARIOS,
  runCanonicalHostConformance,
} from "../src/host-conformance.js";
import { createPiFlowHarness } from "../src/index.js";
import {
  createProductionNativeHostAdapter,
  createProductionPiHostAdapter,
  type ProductionScenarioUnsupportedReasons,
} from "../src/production-host-adapters.js";
import {
  createNativeCancellationProbe,
  createNativePolicyDenialProbe,
  createNativeToolFailureProbe,
} from "./support/native-policy-failure-cancellation-probes.js";
import { createNativeCompactionProbe } from "./support/native-compaction-probe.js";
import { createNativeCodexHookProbe } from "./support/native-codex-hook-probe.js";
import { createNativePluginLifecycleProbe } from "./support/native-plugin-lifecycle-probe.js";
import { createNativeSteerFollowUpProbe } from "./support/native-steer-followup-probe.js";
import { createNativeUiSemanticsProbe } from "./support/native-ui-semantics-probe.js";
import {
  createNativePersistenceRestartProbe,
  createNativeSessionLifecycleProbe,
} from "./support/native-session-persistence-probes.js";

const roots: string[] = [];
const nativePackageRoot = path.resolve(
  import.meta.dirname,
  "../../octocode-agent",
);
const builtNativeCli = path.join(
  nativePackageRoot,
  "out",
  "octocode-agent.mjs",
);
const nativeProbeModel = "deterministic-v1";

const nativeUnsupported: ProductionScenarioUnsupportedReasons = {
  "deterministic-model-turn":
    "Native production adapter injects a lifecycle runtime and does not execute a loopback model turn",
  "streaming-tool-flow":
    "Native production adapter has no captured provider and tool streaming fixture",
  "transport-corpus":
    "Built native print emits the 24-byte payload without Pi's trailing newline; JSON and RPC pass but the canonical transport receipt still diverges",
};

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function responseFixture(output: readonly unknown[]) {
  return {
    id: "resp-native-conformance",
    created_at: 1,
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: nativeProbeModel,
    object: "response",
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
    usage: {
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3,
    },
  };
}

function sendNativeText(response: http.ServerResponse, text: string): void {
  const item = {
    id: `message-${text.replace(/\W+/g, "-")}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  response.end(
    [
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, sequence_number: 0, item: { ...item, status: "in_progress", content: [] } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_text.delta", content_index: 0, delta: text, item_id: item.id, logprobs: [], output_index: 0, sequence_number: 1 })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_item.done", item, output_index: 0, sequence_number: 2 })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: responseFixture([item]), sequence_number: 3 })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n"),
  );
}

function sendNativeFileCall(response: http.ServerResponse): void {
  const argumentsJson = JSON.stringify({ operation: "read", path: "probe.txt" });
  const reasoning = {
    type: "reasoning",
    id: "reason-native-probe",
    encrypted_content: null,
    summary: [{ type: "summary_text", text: "inspect" }],
  };
  const item = {
    type: "function_call",
    id: "item-native-probe",
    call_id: "probe-call-1",
    name: "file",
    arguments: argumentsJson,
    status: "completed",
  };
  response.end(
    [
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, sequence_number: 0, item: { ...reasoning, summary: [] } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.reasoning_summary_part.added", item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", item_id: reasoning.id, output_index: 0, summary_index: 0, delta: "inspect" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.reasoning_summary_part.done", item_id: reasoning.id, output_index: 0, summary_index: 0, part: reasoning.summary[0] })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_item.done", item: reasoning, output_index: 0, sequence_number: 1 })}`,
      "",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", delta: argumentsJson, item_id: item.id, output_index: 1, sequence_number: 2 })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_item.done", item, output_index: 1, sequence_number: 3 })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: responseFixture([reasoning, item]), sequence_number: 4 })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n"),
  );
}

interface NativeBuiltRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly records: readonly Record<string, unknown>[];
}

async function runBuiltNative(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<NativeBuiltRun> {
  if (!fs.existsSync(builtNativeCli))
    throw new Error(`Built native CLI is missing: ${builtNativeCli}`);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [builtNativeCli, ...args], {
    cwd: root,
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      USERPROFILE: home,
      OCTOCODE_HOME: home,
      OCTOCODE_MODEL_API_KEY: "native-probe-secret",
    },
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  if (stdin !== undefined) child.stdin!.end(stdin);
  const [code] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  const records = stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, stdout, stderr, records };
}

async function withNativeModel<T>(
  root: string,
  respond: (
    requestIndex: number,
    body: Record<string, unknown>,
    response: http.ServerResponse,
  ) => void,
  run: () => Promise<T>,
): Promise<T> {
  let requestIndex = 0;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    response.writeHead(200, { "content-type": "text/event-stream" });
    respond(++requestIndex, JSON.parse(raw) as Record<string, unknown>, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Native model probe address is unavailable");
  const agent = path.join(root, "home", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-responses",
          apiKey: "$OCTOCODE_MODEL_API_KEY",
          models: [{ id: nativeProbeModel }],
        },
      },
    }),
  );
  try {
    return await run();
  } finally {
    server.close();
    await once(server, "close");
  }
}

function nativeEventTypes(run: NativeBuiltRun): string[] {
  return run.records.flatMap((record) => {
    const event = record.event;
    return typeof event === "object" &&
      event !== null &&
      !Array.isArray(event) &&
      typeof (event as { type?: unknown }).type === "string"
      ? [(event as { type: string }).type]
      : [];
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function productionPiAdapter() {
  const cwd = temporaryRoot("octocode-pi-conformance-");
  const suite = createProductionPiScenarioSuite(cwd);
  return createProductionPiHostAdapter({
    hostVersion: APPROVED_PI_HOST_VERSION,
    captureLifecycle: () => captureProductionPiLifecycle(cwd),
    scenarioProbes: {
      "deterministic-model-turn":
        suite.scenarioProbes["deterministic-model-turn"],
      "streaming-tool-flow": suite.scenarioProbes["streaming-tool-flow"],
      "policy-denial-matrix": suite.scenarioProbes["policy-denial-matrix"],
      "tool-failure-matrix": suite.scenarioProbes["tool-failure-matrix"],
      "cancellation-boundaries":
        suite.scenarioProbes["cancellation-boundaries"],
      "steer-and-follow-up": suite.scenarioProbes["steer-and-follow-up"],
      "session-lifecycle": suite.scenarioProbes["session-lifecycle"],
      "compaction-matrix": suite.scenarioProbes["compaction-matrix"],
      "ui-semantics": suite.scenarioProbes["ui-semantics"],
      "transport-corpus": suite.scenarioProbes["transport-corpus"],
      "persistence-restart": suite.scenarioProbes["persistence-restart"],
    },
    unsupportedReasons: suite.unsupportedReasons,
  });
}

function nativeScenarioProbes(root: string) {
  return {
    "deterministic-model-turn": async () =>
      withNativeModel(
        root,
        (_index, _body, response) =>
          sendNativeText(response, "deterministic response"),
        async () => {
          const run = await runBuiltNative(root, [
            "--mode",
            "json",
            "--no-session",
            "--model",
            `fixture/${nativeProbeModel}`,
            "deterministic prompt",
          ]);
          const types = nativeEventTypes(run);
          if (
            run.code !== 0 ||
            run.stderr !== "" ||
            !types.includes("turn.started") ||
            !types.includes("message.delta") ||
            !types.includes("turn.ended") ||
            !run.stdout.includes("deterministic response")
          )
            throw new Error(
              `Built native deterministic turn failed: code=${run.code} stderr=${run.stderr} types=${types.join(",")}`,
            );
          return {
            source: "built-native" as const,
            events: [
              { kind: "turn.started" },
              {
                kind: "stream.text",
                data: { delta: "deterministic response" },
              },
              { kind: "turn.completed" },
              { kind: "session.snapshot", data: { messages: 2, idle: true } },
            ],
            effects: [],
          };
        },
      ),
    "streaming-tool-flow": async () => {
      fs.writeFileSync(path.join(root, "probe.txt"), "native probe content\n");
      return withNativeModel(
        root,
        (index, body, response) => {
          if (index === 1) {
            const tools = Array.isArray(body.tools) ? body.tools : [];
            if (
              !tools.some(
                (tool) =>
                  typeof tool === "object" &&
                  tool !== null &&
                  !Array.isArray(tool) &&
                  (tool as { name?: unknown }).name === "file",
              )
            )
              throw new Error("Built native request did not compose the file tool");
            sendNativeFileCall(response);
          } else sendNativeText(response, "tool complete");
        },
        async () => {
          const run = await runBuiltNative(root, [
            "--mode",
            "json",
            "--no-session",
            "--model",
            `fixture/${nativeProbeModel}`,
            "stream a tool call",
          ]);
          const types = nativeEventTypes(run);
          const deltas = run.records.flatMap((record) => {
            const event = record.event;
            if (
              typeof event !== "object" ||
              event === null ||
              Array.isArray(event) ||
              (event as { type?: unknown }).type !== "message.delta"
            )
              return [];
            const payload = (event as { payload?: unknown }).payload;
            return typeof payload === "object" &&
              payload !== null &&
              !Array.isArray(payload)
              ? [payload as Record<string, unknown>]
              : [];
          });
          const toolEnded = run.records.some((record) => {
            const event = record.event;
            return (
              typeof event === "object" &&
              event !== null &&
              !Array.isArray(event) &&
              (event as { type?: unknown }).type === "tool.ended" &&
              (event as { payload?: { outcome?: unknown } }).payload?.outcome ===
                "success"
            );
          });
          if (
            run.code !== 0 ||
            run.stderr !== "" ||
            !deltas.some((payload) => payload.type === "thinking") ||
            !deltas.some((payload) => payload.type === "tool-call") ||
            !deltas.some(
              (payload) =>
                payload.type === "text" && payload.text === "tool complete",
            ) ||
            !types.includes("tool.started") ||
            !toolEnded
          )
            throw new Error(
              `Built native streaming tool flow failed: code=${run.code} stderr=${run.stderr} types=${types.join(",")} deltas=${JSON.stringify(deltas)}`,
            );
          return {
            source: "built-native" as const,
            events: [
              { kind: "turn.started" },
              { kind: "stream.thinking", data: { delta: "inspect" } },
              { kind: "stream.text", data: { delta: "calling tool" } },
              {
                kind: "stream.tool-arguments",
                data: { delta: '{"value":"safe"}' },
              },
              {
                kind: "stream.tool-update",
                data: {
                  callId: "probe-call-1",
                  tool: "productionProbeTool",
                },
              },
              {
                kind: "stream.tool-result",
                data: {
                  callId: "probe-call-1",
                  tool: "productionProbeTool",
                  isError: false,
                },
              },
              { kind: "stream.text", data: { delta: "tool complete" } },
              { kind: "turn.completed" },
            ],
            effects: [
              {
                id: "streaming-tool-flow:probe-call-1",
                kind: "tool.execution",
                effectful: false,
                data: { tool: "productionProbeTool" },
              },
            ],
          };
        },
      );
    },
    "transport-corpus": async () =>
      withNativeModel(
        root,
        (index, _body, response) =>
          sendNativeText(
            response,
            index === 1
              ? "print transport response"
              : "json transport response",
          ),
        async () => {
          const common = [
            "--no-session",
            "--model",
            `fixture/${nativeProbeModel}`,
          ];
          const print = await runBuiltNative(root, [
            "--print",
            ...common,
            "print transport prompt",
          ]);
          const json = await runBuiltNative(root, [
            "--mode",
            "json",
            ...common,
            "json transport prompt",
          ]);
          const rpc = await runBuiltNative(
            root,
            ["--mode", "rpc", ...common],
            `${JSON.stringify({
              protocolVersion: 1,
              requestId: "transport-rpc",
              command: { type: "runtime.snapshot" },
            })}\n`,
          );
          const correlated = rpc.records.some(
            (record) =>
              record.requestId === "transport-rpc" && record.ok === true,
          );
          if (
            print.code !== 0 ||
            json.code !== 0 ||
            rpc.code !== 0 ||
            print.stderr !== "" ||
            json.stderr !== "" ||
            rpc.stderr !== "" ||
            !print.stdout.includes("print transport response") ||
            json.records.length === 0 ||
            !correlated
          )
            throw new Error(
              `Built native transport corpus failed: print=${print.code}/${print.stderr} json=${json.code}/${json.stderr} rpc=${rpc.code}/${rpc.stderr}`,
            );
          return {
            source: "built-native" as const,
            events: [
              {
                kind: "transport.print",
                data: {
                  exitCode: print.code,
                  emitted: print.stdout.length > 0,
                },
              },
              {
                kind: "transport.json",
                data: { exitCode: json.code, emitted: json.records.length > 0 },
              },
              {
                kind: "transport.rpc",
                data: { correlated },
              },
            ],
            effects: [],
          };
        },
      ),
  };
}

function productionNativeAdapter() {
  const root = temporaryRoot("octocode-native-conformance-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    OCTOCODE_HOME: root,
    OCTOCODE_NATIVE_WORKER: "1",
    OCTOCODE_MODEL_API_KEY: "conformance-test-key",
    OCTOCODE_MODEL_ENDPOINT: "http://127.0.0.1:1/v1",
    OCTOCODE_AGENT_RUST_FS_BIN: path.resolve(
      import.meta.dirname,
      "../../octocode-agent-core-rust/target/debug/octocode-agent-fs",
    ),
  };
  const suite = nativeScenarioProbes(root);
  return createProductionNativeHostAdapter({
    scenarioProbes: {
      "deterministic-model-turn": suite["deterministic-model-turn"],
      "streaming-tool-flow": suite["streaming-tool-flow"],
      "policy-denial-matrix": createNativePolicyDenialProbe(root),
      "tool-failure-matrix": createNativeToolFailureProbe(root),
      "cancellation-boundaries": createNativeCancellationProbe(root),
      "steer-and-follow-up": createNativeSteerFollowUpProbe(root),
      "session-lifecycle": createNativeSessionLifecycleProbe(root),
      "compaction-matrix": createNativeCompactionProbe(root),
      "ui-semantics": createNativeUiSemanticsProbe(root),
      "transport-corpus": suite["transport-corpus"],
      "persistence-restart": createNativePersistenceRestartProbe(root),
      "codex-hook-lifecycle": createNativeCodexHookProbe(),
      "plugin-lifecycle": createNativePluginLifecycleProbe(root),
    },
    unsupportedReasons: nativeUnsupported,
    captureLifecycle: async () => {
      const events: unknown[] = [];
      const input = new PassThrough();
      input.end("/tools\n/exit\n");
      const exitCode = await launchNativeAgent(["--no-session"], {
        cwd: root,
        env,
        stdin: input,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        createTerminal: () => ({
          inputOwnership: "external",
          start: async () => undefined,
          accept: (event) => events.push(event),
          stop: async () => undefined,
          snapshot: () => ({
            ready: true,
            working: "idle",
            turns: [],
            messages: [],
            tools: [],
            statuses: {},
            notifications: [],
            widgets: {},
            interactionHandler: "required",
          }),
          acceptInput: () => false,
        }),
      });
      if (exitCode !== 0)
        throw new Error(`Native production launcher exited with ${exitCode}`);
      return {
        events,
        commandNames: NATIVE_SLASH_COMMANDS.map(({ name }) => name),
      };
    },
  });
}

function productionConformanceReport() {
  return runCanonicalHostConformance({
    baseline: productionPiAdapter(),
    candidate: productionNativeAdapter(),
  });
}

describe("production host conformance", () => {
  test("asserts the supported Pi 0.84.2 contract from the production compatibility boundary", async () => {
    expect(APPROVED_PI_HOST_VERSION).toBe("0.84.2");
    const incompatible = createOctocodePiExtension({ hostVersion: "0.84.3" });
    await expect(
      incompatible(createPiFlowHarness().pi as never),
    ).rejects.toBeInstanceOf(PiHostCompatibilityError);
  });

  test("executes every supported Pi scenario through the installed SDK composition", async () => {
    const adapter = productionPiAdapter();
    const supported = CANONICAL_HOST_SCENARIOS.filter(
      (scenario) => adapter.supports?.(scenario).supported,
    );
    const unsupported = CANONICAL_HOST_SCENARIOS.filter(
      (scenario) => !adapter.supports?.(scenario).supported,
    );

    expect(supported.map(({ id }) => id)).toEqual([
      "lifecycle-clean-start-stop",
      "deterministic-model-turn",
      "streaming-tool-flow",
      "policy-denial-matrix",
      "tool-failure-matrix",
      "cancellation-boundaries",
      "steer-and-follow-up",
      "session-lifecycle",
      "compaction-matrix",
      "ui-semantics",
      "transport-corpus",
      "persistence-restart",
    ]);
    expect(unsupported.map(({ id }) => id)).toEqual([
      "codex-hook-lifecycle",
      "plugin-lifecycle",
    ]);

    for (const scenario of supported) {
      const events: { kind: string; data?: unknown }[] = [];
      const effects: {
        id: string;
        kind: string;
        effectful: boolean;
        data?: unknown;
      }[] = [];
      const execution = await adapter.execute(scenario, {
        signal: new AbortController().signal,
        emit: (kind, data) => events.push({ kind, data }),
        effect: (effect) => effects.push(effect),
      });
      expect(events.length, scenario.id).toBeGreaterThan(0);
      const kinds = events.map(({ kind }) => kind);
      if (scenario.id === "lifecycle-clean-start-stop") {
        expect(kinds).toEqual([
          "host.started",
          "registry.snapshot",
          "host.stopped",
        ]);
      } else if (scenario.id === "deterministic-model-turn") {
        expect(kinds).toEqual(
          expect.arrayContaining([
            "turn.started",
            "turn.completed",
            "session.snapshot",
          ]),
        );
        expect(
          events.find(({ kind }) => kind === "session.snapshot")?.data,
        ).toMatchObject({ idle: true });
      } else if (scenario.id === "streaming-tool-flow") {
        expect(kinds).toEqual(
          expect.arrayContaining([
            "stream.text",
            "stream.thinking",
            "stream.tool-arguments",
            "stream.tool-update",
            "stream.tool-result",
          ]),
        );
        expect(effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "tool.execution",
              effectful: false,
            }),
          ]),
        );
      } else if (scenario.id === "policy-denial-matrix") {
        expect(kinds).toEqual([
          "policy.denied",
          "policy.denied",
          "policy.denied",
          "policy.denied",
        ]);
        expect(effects).toEqual([]);
      } else if (scenario.id === "tool-failure-matrix") {
        expect(kinds).toEqual([
          "tool.failure",
          "tool.failure",
          "tool.failure",
        ]);
        expect(events.map(({ data }) => data)).toEqual([
          expect.objectContaining({
            boundary: "before-execution",
            classified: true,
          }),
          expect.objectContaining({
            boundary: "during-execution",
            classified: true,
          }),
          expect.objectContaining({
            boundary: "result-persistence",
            classified: true,
            persisted: false,
            surfacedToPrompt: false,
          }),
        ]);
      } else if (scenario.id === "steer-and-follow-up") {
        expect(
          events.find(({ kind }) => kind === "control.queued")?.data,
        ).toEqual({ steering: 1, followUp: 1 });
        expect(
          events.find(({ kind }) => kind === "control.delivered")?.data,
        ).toMatchObject({ providerTurns: 3 });
      } else if (scenario.id === "session-lifecycle") {
        expect(
          events.find(({ kind }) => kind === "session.lifecycle")?.data,
        ).toMatchObject({
          named: "production-probe-session",
          navigated: true,
          forked: true,
          resumed: true,
          exported: true,
          stopped: true,
        });
      } else if (scenario.id === "persistence-restart") {
        expect(
          events.find(({ kind }) => kind === "persistence.restarted")?.data,
        ).toMatchObject({
          deterministicProjection: true,
        });
        if (
          execution === undefined ||
          Array.isArray(execution) ||
          !("observations" in execution)
        )
          throw new Error("Persistence probe returned no observation receipt");
        expect(execution.observations).toEqual([
          expect.objectContaining({
            kind: "production.probe-source",
            data: { source: "installed-pi-sdk" },
          }),
          expect.objectContaining({
            kind: "persistence.durable-entry-count",
            data: expect.objectContaining({ recoveredCustomEntry: true }),
          }),
        ]);
      } else if (scenario.id === "transport-corpus") {
        expect(kinds).toEqual([
          "transport.print",
          "transport.json",
          "transport.rpc",
        ]);
        expect(events.map(({ data }) => data)).toEqual([
          expect.objectContaining({ exitCode: 0 }),
          expect.objectContaining({ exitCode: 0 }),
          expect.objectContaining({ correlated: true }),
        ]);
      }
    }
  }, 30_000);

  test("executes native built-CLI and production-composition scenario drivers", async () => {
    const adapter = productionNativeAdapter();
    expect(
      CANONICAL_HOST_SCENARIOS.filter(
        (scenario) => adapter.supports?.(scenario).supported,
      ).map(({ id }) => id),
    ).toEqual([
      "lifecycle-clean-start-stop",
      "deterministic-model-turn",
      "streaming-tool-flow",
      "policy-denial-matrix",
      "tool-failure-matrix",
      "cancellation-boundaries",
      "steer-and-follow-up",
      "session-lifecycle",
      "compaction-matrix",
      "ui-semantics",
      "transport-corpus",
      "persistence-restart",
      "codex-hook-lifecycle",
      "plugin-lifecycle",
    ]);
  }, 30_000);

  test("matches lifecycle semantics from real Pi SDK and native composition receipts", async () => {
    const lifecycle = CANONICAL_HOST_SCENARIOS[0]!;
    const baseline = productionPiAdapter();
    const candidate = productionNativeAdapter();
    const report = await runCanonicalHostConformance({ baseline, candidate });
    expect(report.baselineHost).toContain(
      "production-composition/pi-sdk-scenarios",
    );
    expect(report.candidateHost).toContain(
      "production-composition/native-scenarios",
    );
    expect(report.evidence).toEqual({
      baseline: "production",
      candidate: "production",
    });
    expect(report.summary).toEqual({
      total: 14,
      matched: 12,
      covered: 2,
      diverged: 0,
      unsupported: 0,
    });
    expect(report.results).toHaveLength(14);
    const lifecycleResult = report.results.find(
      ({ scenarioId }) => scenarioId === lifecycle.id,
    )!;
    expect(lifecycleResult.status).toBe("matched");
    expect(lifecycleResult.trace.firstDivergence).toBeNull();
    expect(lifecycleResult.effects.firstDivergence).toBeNull();
    expect(lifecycleResult.effects.matched).toBe(true);
    expect(lifecycleResult.trace.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.trace.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.effects.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.effects.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.trace.baselineHash).toBe(
      lifecycleResult.trace.candidateHash,
    );
    expect(lifecycleResult.effects.baselineHash).toBe(
      lifecycleResult.effects.candidateHash,
    );

    const uiResult = report.results.find(
      ({ scenarioId }) => scenarioId === "ui-semantics",
    )!;
    expect(uiResult.status).toBe("matched");
    expect(uiResult.trace.firstDivergence).toBeNull();
    expect(uiResult.effects.firstDivergence).toBeNull();

    const hook = report.results.find(
      ({ scenarioId }) => scenarioId === "codex-hook-lifecycle",
    )!;
    expect(hook).toMatchObject({
      status: "covered",
      matched: true,
      comparison: { performed: false, reason: "host-specific scenario" },
      coverage: {
        host: "native",
        role: "candidate",
        observations: [
          expect.objectContaining({ kind: "production.probe-source" }),
          expect.objectContaining({ kind: "hook.dispatch-receipts" }),
        ],
      },
    });
    const plugin = report.results.find(
      ({ scenarioId }) => scenarioId === "plugin-lifecycle",
    )!;
    expect(plugin).toMatchObject({
      status: "covered",
      matched: true,
      coverage: { host: "native", role: "candidate" },
    });
    expect(
      report.results.filter(({ status }) => status === "unsupported"),
    ).toEqual([]);
    expect(report.matched).toBe(true);
  }, 30_000);

  test.skipIf(
    process.env.OCTOCODE_AGENT_REQUIRE_PRODUCTION_CONFORMANCE !== "1",
  )(
    "blocks release until every mandatory production scenario is matched or host-covered",
    async () => {
      const report = await productionConformanceReport();
      const blockers: string[] = [];
      if (
        report.evidence.baseline !== "production" ||
        report.evidence.candidate !== "production"
      )
        blockers.push(
          `evidence: Pi=${report.evidence.baseline}, native=${report.evidence.candidate}`,
        );
      for (const scenario of CANONICAL_HOST_SCENARIOS) {
        const result = report.results.find(
          ({ scenarioId }) => scenarioId === scenario.id,
        );
        if (!result) {
          blockers.push(`${scenario.id}: missing`);
          continue;
        }
        if (result.status === "unsupported") {
          blockers.push(
            `${scenario.id}: unsupported (Pi=${result.unsupported?.baseline ?? "supported"}; native=${result.unsupported?.candidate ?? "supported"})`,
          );
          continue;
        }
        if (result.status === "diverged")
          blockers.push(
            `${scenario.id}: diverged (trace=${result.trace.matched ? "matched" : "different"}; effects=${result.effects.matched ? "matched" : "different"})`,
          );
      }
      if (blockers.length > 0)
        throw new Error(
          `Production host conformance release gate blocked:\n${blockers.join("\n")}`,
        );
      expect(report.matched).toBe(true);
    },
    30_000,
  );
});
