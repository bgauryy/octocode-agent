import {
  ToolRegistry,
  sessionId,
  turnId,
  type ToolExecutionInput,
  type ToolResult,
} from "@octocodeai/agent-core";
import {
  createNativeInteractionBroker,
  registerNativeAskUserTool,
} from "../../../octocode-agent/src/native-interactions.js";
import {
  createOpenTuiUiPort,
  type OpenTuiRendererFacade,
  type PresentationState,
} from "../../../octocode-agent/src/terminal/opentui/presentation.js";
import { createOpenTuiTerminal } from "../../../octocode-agent/src/terminal/opentui/create-terminal.js";
import { TranscriptWidget } from "../../../octocode-agent/src/terminal/opentui/widgets/transcript.js";
import type {
  ProductionScenarioProbe,
  ProductionScenarioReceipt,
} from "../../src/production-host-adapters.js";

type SemanticEvent = ProductionScenarioReceipt["events"][number];

const HIDDEN_THINKING = "HIDDEN_REASONING_SENTINEL";

function execution(
  cwd: string,
  signal: AbortSignal,
  input: unknown,
  callId: string,
): ToolExecutionInput {
  return {
    input,
    callId: callId as never,
    context: {
      sessionId: sessionId("ui-probe-session"),
      turnId: turnId("ui-probe-turn"),
      cwd,
      mode: "interactive",
      trust: { workspace: "trusted", managedOnly: false },
      signal,
    },
    signal,
    update: async () => undefined,
  };
}

function acceptedValue(result: ToolResult): unknown {
  if (
    !result.ok ||
    typeof result.content !== "object" ||
    result.content === null
  )
    throw new Error(
      "Native interactive askUser did not return structured content",
    );
  const content = result.content as { status?: unknown; value?: unknown };
  if (content.status !== "accepted")
    throw new Error(
      `Native interactive askUser returned ${String(content.status)}`,
    );
  return content.value;
}

async function waitForQuestion(
  snapshot: () => PresentationState,
  questionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      snapshot().interaction?.status === "pending" &&
      snapshot().interaction?.request.workflow?.questionId === questionId
    )
      return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Native UI did not present workflow question ${questionId}`);
}

async function waitForDialog(
  snapshot: () => PresentationState,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      snapshot().interaction?.status === "pending" &&
      snapshot().interaction?.request.message === message
    )
      return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Native UI did not present dialog ${message}`);
}

function validateScenario(input: Readonly<Record<string, unknown>>): void {
  const adapters = input.adapters;
  if (
    !Array.isArray(adapters) ||
    adapters.length !== 2 ||
    adapters[0] !== "interactive" ||
    adapters[1] !== "headless"
  )
    throw new Error(
      "Native UI conformance requires interactive and headless adapters in canonical order",
    );
}

/**
 * Exercise native UI production components while emitting only canonical
 * semantic events. Native renderer evidence remains observation-only.
 */
export function createNativeUiSemanticsProbe(
  cwd: string,
): ProductionScenarioProbe {
  return async ({ scenario, signal }) => {
    validateScenario(scenario.input);
    if (signal.aborted) throw signal.reason;

    const events: SemanticEvent[] = [];
    const rendered: PresentationState[] = [];
    const renderer: OpenTuiRendererFacade = {
      render(state) {
        rendered.push(state);
      },
      destroy: async () => undefined,
    };
    const terminal = createOpenTuiTerminal({
      inputOwnership: "external",
      createRenderer: async () => renderer,
    });
    await terminal.start();

    try {
      const broker = createNativeInteractionBroker();
      const detach = broker.attach((request, interactionSignal) =>
        terminal.interact!(request, interactionSignal),
      );
      const registry = new ToolRegistry();
      registerNativeAskUserTool(registry, broker);
      const askUser = registry.get("askUser");
      if (!askUser)
        throw new Error("Native askUser production tool is missing");

      const runDialog = async (
        input: unknown,
        answer: string,
        event: SemanticEvent,
        callId: string,
      ): Promise<unknown> => {
        const pending = askUser.execute(execution(cwd, signal, input, callId));
        const message = (input as { question?: unknown }).question;
        if (typeof message !== "string")
          throw new Error(`Native UI dialog ${callId} has no question`);
        await waitForDialog(terminal.snapshot.bind(terminal), message);
        if (!terminal.acceptInput?.(answer))
          throw new Error(`Native UI did not accept ${callId}`);
        const value = acceptedValue(await pending);
        events.push(event);
        return value;
      };

      const selected = await runDialog(
        {
          type: "select",
          question: "probe:select",
          options: ["first", "second"],
        },
        "1",
        { kind: "ui.select", data: { title: "probe:select", count: 2 } },
        "ui:select",
      );
      const confirmed = await runDialog(
        { type: "confirm", question: "probe:confirm" },
        "yes",
        { kind: "ui.confirm", data: { title: "probe:confirm" } },
        "ui:confirm",
      );
      const inputValue = await runDialog(
        { type: "input", question: "probe:input" },
        "probe-input",
        { kind: "ui.input", data: { title: "probe:input" } },
        "ui:input",
      );
      const editorValue = await runDialog(
        {
          type: "editor",
          question: "probe:editor",
          initial: "prefill",
        },
        "probe-editor",
        { kind: "ui.editor", data: { title: "probe:editor" } },
        "ui:editor",
      );

      const ui = createOpenTuiUiPort(terminal);
      await ui.notify("probe:notify", "info");
      events.push({
        kind: "ui.notify",
        data: { message: "probe:notify", type: "info" },
      });
      await ui.setStatus("probe:status", "active");
      events.push({
        kind: "ui.status",
        data: { key: "probe:status", active: true },
      });
      terminal.accept({
        type: "chrome-changed",
        chrome: {
          authority: "runtime",
          title: "probe:title",
          trust: "trusted",
        },
      });
      events.push({ kind: "ui.title", data: { title: "probe:title" } });
      events.push({
        kind: "ui.command-observed",
        data: {
          hasUI: false,
          selected: null,
          confirmed: false,
          inputAvailable: false,
          editorAvailable: false,
        },
      });

      const workflowPending = askUser.execute(
        execution(
          cwd,
          signal,
          {
            title: "Implementation choices",
            instructions:
              "Answer known items; choose Discuss when context is missing.",
            questions: [
              {
                id: "runtime",
                type: "select",
                question: "Runtime?",
                options: ["Rust", "TypeScript"],
              },
              { id: "storage", type: "input", question: "Storage?" },
              { id: "rendering", type: "input", question: "Rendering?" },
            ],
          },
          "ui:workflow",
        ),
      );
      await waitForQuestion(terminal.snapshot.bind(terminal), "runtime");
      terminal.acceptInput!("1");
      await waitForQuestion(terminal.snapshot.bind(terminal), "storage");
      terminal.acceptInput!("/discuss");
      const workflow = await workflowPending;
      if (!workflow.ok || typeof workflow.content !== "object")
        throw new Error("Native UI workflow did not return structured content");
      const workflowContent = workflow.content as {
        status?: unknown;
        answers?: readonly unknown[];
        remainingQuestionIds?: readonly unknown[];
      };

      terminal.accept({ type: "turn-started", turnId: "ui-probe-turn" });
      terminal.accept({
        type: "message-started",
        messageId: "ui-probe-message",
        role: "assistant",
        turnId: "ui-probe-turn",
      });
      terminal.accept({
        type: "message-delta",
        messageId: "ui-probe-message",
        role: "assistant",
        turnId: "ui-probe-turn",
        segment: "thinking",
        text: HIDDEN_THINKING,
      });
      terminal.accept({
        type: "plan-changed",
        plan: {
          authority: "runtime",
          planId: "ui-probe-plan",
          scope: { sessionId: "ui-probe-session", workspace: cwd },
          revision: 1,
          phase: "active",
          steps: [{ id: "ui-step", text: "Validate UI", status: "doing" }],
        },
      });
      terminal.accept({
        type: "worker-changed",
        worker: {
          workerId: "ui-worker",
          agentType: "reviewer",
          state: "running",
          active: 1,
          queued: 0,
          maxActive: 4,
          planStepId: "ui-step",
          taskLabel: "Validate UI",
          timestamp: 1,
        },
      });
      terminal.accept({
        type: "tool-started",
        callId: "ui-tool",
        name: "file",
        turnId: "ui-probe-turn",
      });
      terminal.accept({
        type: "tool-progress",
        callId: "ui-tool",
        name: "file",
        message: "Reading",
        current: 1,
        total: 2,
      });

      const interactive = terminal.snapshot();
      const transcript = new TranscriptWidget(
        "ui-probe-transcript",
        interactive.messages,
      ).alternateOutput();
      const chrome = interactive.chrome;
      const explicitStateWords = [
        interactive.runtimeWidgets?.plan?.phase,
        interactive.workers[0]?.state,
        interactive.tools[0]?.status,
        interactive.interaction?.status,
      ];

      detach();
      const headlessBroker = createNativeInteractionBroker();
      const headlessRegistry = new ToolRegistry();
      registerNativeAskUserTool(headlessRegistry, headlessBroker);
      const headlessAsk = headlessRegistry.get("askUser");
      if (!headlessAsk) throw new Error("Headless askUser tool is missing");
      const headlessInputs = [
        {
          type: "select",
          question: "probe:select",
          options: ["first", "second"],
        },
        { type: "confirm", question: "probe:confirm" },
        { type: "input", question: "probe:input" },
        {
          type: "editor",
          question: "probe:editor",
          initial: "prefill",
        },
      ];
      const headlessResults = await Promise.all(
        headlessInputs.map((input, index) =>
          headlessAsk.execute(
            execution(cwd, signal, input, `ui:headless:${index}`),
          ),
        ),
      );
      const dialogsReturnedValues = headlessResults.some((result) => {
        const content = result.content as { status?: unknown; value?: unknown };
        return content.status === "accepted" || content.value !== undefined;
      });
      events.push({
        kind: "ui.headless",
        data: {
          mode: "json",
          rejected: false,
          providerCalls: 0,
          hasUI: false,
          dialogsReturnedValues,
        },
      });

      if (dialogsReturnedValues)
        throw new Error("Headless native UI exposed interactive values");
      if (
        selected !== "first" ||
        confirmed !== true ||
        inputValue !== "probe-input" ||
        editorValue !== "probe-editor"
      )
        throw new Error("Native interactive UI returned unexpected values");

      return {
        source: "native-production-composition",
        events,
        effects: [],
        observations: [
          {
            kind: "native.ui.interactive-values",
            data: {
              hasUI: true,
              selected,
              confirmed,
              inputAvailable: inputValue !== undefined,
              editorAvailable: editorValue !== undefined,
            },
          },
          {
            kind: "native.ui.workflow",
            data: {
              oneAtATime:
                workflowContent.remainingQuestionIds?.[0] === "storage",
              discuss: workflowContent.status === "discuss",
              priorAnswersPreserved: workflowContent.answers?.length === 1,
              questionCount: 3,
            },
          },
          {
            kind: "native.ui.visible-state",
            data: {
              plan: interactive.runtimeWidgets?.plan?.phase === "active",
              task: interactive.workers[0]?.taskLabel === "Validate UI",
              worker: interactive.workers[0]?.state === "running",
              tool: interactive.tools[0]?.status === "running",
              thinking: transcript.includes("[thinking]"),
              hiddenThinkingPayloadVisible:
                transcript.includes(HIDDEN_THINKING),
              colorRequiredForMeaning:
                explicitStateWords.some((word) => !word) ||
                explicitStateWords.some((word) =>
                  /\u001b\[/u.test(String(word)),
                ),
            },
          },
          {
            kind: "native.ui.renderer",
            data: {
              controllerStarted: rendered.length > 0,
              renderedSnapshots: rendered.length,
              titleProjected: chrome?.title === "probe:title",
            },
          },
        ],
      };
    } finally {
      await terminal.stop();
    }
  };
}
