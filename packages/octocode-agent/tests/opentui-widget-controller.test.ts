import { describe, expect, it, vi } from "vitest";

import {
  createInitialPresentationState,
  reducePresentation,
  type PresentationState,
} from "../src/terminal/opentui/presentation.js";
import { SemanticWidgetController } from "../src/terminal/opentui/widget-controller.js";
import { ConfirmWidget } from "../src/terminal/opentui/widgets/confirm.js";
import {
  type WidgetContract,
  type WidgetRenderAdapter,
  type WidgetRenderState,
} from "../src/terminal/opentui/widgets/contracts.js";
import { PromptInputWidget } from "../src/terminal/opentui/widgets/prompt-input.js";
import { SelectWidget } from "../src/terminal/opentui/widgets/select.js";

class RecordingAdapter implements WidgetRenderAdapter {
  readonly states = new Map<string, WidgetRenderState>();
  readonly destroyed: string[] = [];
  binding?: { generation: number; widget: WidgetContract };
  focusedId?: string;
  readonly navigation: { id: string; key: string; offset?: number }[] = [];

  render(state: WidgetRenderState): void {
    this.states.set(state.id, state);
  }

  destroy(widgetId: string): void {
    this.destroyed.push(widgetId);
    this.states.delete(widgetId);
  }

  bindInteraction(
    generation: number | undefined,
    widget: WidgetContract | undefined,
  ): void {
    this.binding =
      generation === undefined || widget === undefined
        ? undefined
        : { generation, widget };
  }

  focusWidget(widgetId: string | undefined): void {
    this.focusedId = widgetId;
  }

  navigateWidget(widgetId: string, key: string, absoluteOffset?: number): void {
    this.navigation.push({
      id: widgetId,
      key,
      ...(absoluteOffset === undefined ? {} : { offset: absoluteOffset }),
    });
  }
}

function withRuntimeWidgets(state: PresentationState): PresentationState {
  let projected = reducePresentation(state, {
    type: "chrome-changed",
    chrome: {
      authority: "runtime",
      title: "Octocode",
      trust: "trusted",
      sessionId: "session-1",
      modelId: "model-1",
    },
  });
  projected = reducePresentation(projected, { type: "runtime-ready" });
  projected = reducePresentation(projected, {
    type: "turn-started",
    turnId: "turn-1",
  });
  return reducePresentation(projected, {
    type: "runtime-widgets-changed",
    snapshots: {
      plan: {
        authority: "runtime",
        planId: "plan-1",
        scope: { sessionId: "session-1", workspace: "/workspace" },
        revision: 1,
        phase: "active",
        steps: [{ id: "step-1", text: "Test widgets", status: "doing" }],
      },
      statusNotifications: [
        {
          authority: "runtime",
          slot: "agent",
          id: "run-1",
          message: "Agent is working",
          lifecycle: "active",
        },
      ],
    },
  });
}

describe("SemanticWidgetController", () => {
  it("projects transcript, tools, and only runtime-authoritative chrome snapshots", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter, {
      widthColumns: 80,
      heightRows: 24,
      reducedMotion: true,
    });
    let state = reducePresentation(createInitialPresentationState(), {
      type: "message-started",
      messageId: "message-1",
      role: "assistant",
      turnId: "turn-1",
    });
    state = reducePresentation(state, {
      type: "message-delta",
      messageId: "message-1",
      text: "Hello",
    });
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "call-1",
      name: "localSearch",
    });
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "call-plan",
      name: "plan",
    });
    controller.render(state);

    expect([...adapter.states.values()].map(({ kind }) => kind)).toEqual([
      "transcript",
      "tool.progress",
      "tool.progress",
    ]);
    const planTool = [...adapter.states.values()].find(
      ({ kind, regions }) =>
        kind === "tool.progress" &&
        regions.some(({ text }) => text.includes("Plan")),
    );
    expect(planTool).toBeDefined();
    expect(
      planTool!.regions.some(({ text }) => text.includes("Plan and Tasks")),
    ).toBe(false);
    expect(
      [...adapter.states.values()].some(({ kind }) => kind === "header"),
    ).toBe(false);

    controller.render(withRuntimeWidgets(state));
    expect(
      new Set([...adapter.states.values()].map(({ kind }) => kind)),
    ).toEqual(
      new Set([
        "transcript",
        "tool.progress",
        "header",
        "footer",
        "plan",
        "status.notifications",
      ]),
    );
    expect(
      [...adapter.states.values()].filter(
        ({ kind }) => kind === "tool.progress",
      ),
    ).toHaveLength(1);
    expect(
      [...adapter.states.values()].filter(
        ({ kind, regions }) =>
          kind === "tool.progress" &&
          regions.some(({ text }) => text === "Plan"),
      ),
    ).toHaveLength(0);
    expect(controller.alternateOutput()).toContain("Octocode");
    expect(controller.alternateOutput()).toContain("Hello");
    expect(controller.alternateOutput()).toContain("Agent is working");
  });

  it("renders MCP discovery and refresh as semantic phases while preserving the full result", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = reducePresentation(createInitialPresentationState(), {
      type: "tool-requested",
      callId: "mcp-discovery",
      name: "MCPTool",
      input: JSON.stringify({ action: "discover", server: "fixture" }),
    });
    state = reducePresentation(state, {
      type: "tool-result",
      callId: "mcp-discovery",
      name: "MCPTool",
      result: JSON.stringify({
        server: "fixture",
        source: "server",
        toolCount: 2,
        tools: [{ name: "alpha" }, { name: "beta" }],
      }),
    });
    controller.render(state);

    const rendered = [...adapter.states.values()].find(
      ({ kind }) => kind === "tool.progress",
    );
    expect(
      rendered?.regions.some(({ text }) =>
        text.includes("Discover tools · fixture"),
      ),
    ).toBe(true);
    expect(
      rendered?.regions.some(({ text }) => text.includes("2 tools · server")),
    ).toBe(true);
    expect(state.tools[0]?.result).toContain('"alpha"');
  });

  it("projects stable worker lifecycle rows into dedicated Activity widgets", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(
      adapter,
      { widthColumns: 40, heightRows: 18, alternateOutput: true },
      { nowMs: () => 5_000 },
    );
    let state = reducePresentation(createInitialPresentationState(), {
      type: "worker-changed",
      worker: {
        workerId: "worker:one",
        agentType: "researcher",
        state: "running",
        timestamp: 1_000,
      },
    });
    state = reducePresentation(state, {
      type: "chrome-changed",
      chrome: { authority: "runtime", title: "Octocode", trust: "trusted" },
    });
    controller.render(state);
    const running = [...adapter.states.values()].find(
      ({ kind }) => kind === "worker.progress",
    );
    expect(running?.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "state",
          tone: "info",
          text: "● RUNNING",
        }),
        expect.objectContaining({ id: "elapsed", text: "Elapsed 4s" }),
      ]),
    );
    const compactFooter = [...adapter.states.values()].find(
      ({ kind }) => kind === "footer",
    );
    expect(compactFooter?.regions).toEqual([
      expect.objectContaining({
        id: "activity",
        tone: "info",
        text: expect.stringContaining("1 subagent"),
      }),
    ]);

    state = reducePresentation(state, {
      type: "worker-changed",
      worker: { workerId: "worker:one", state: "succeeded", timestamp: 6_000 },
    });
    state = reducePresentation(state, {
      type: "worker-changed",
      worker: { workerId: "worker:one", state: "running", timestamp: 5_000 },
    });
    state = reducePresentation(state, {
      type: "worker-changed",
      worker: { workerId: "worker:one", state: "running", timestamp: 6_000 },
    });
    controller.render(state);
    const completed = [...adapter.states.values()].find(
      ({ kind }) => kind === "worker.progress",
    );
    expect(completed?.regions[0]).toMatchObject({
      tone: "success",
      text: "✓ SUCCEEDED",
    });
    expect(
      [...adapter.states.values()].find(({ kind }) => kind === "footer")
        ?.regions,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "activity" })]),
    );
    expect(controller.alternateOutput()).not.toContain("worker:one");
  });

  it("keeps worker-card details private while retaining aggregate footer capacity", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter, {
      widthColumns: 40,
      heightRows: 18,
      alternateOutput: true,
    });
    let state = reducePresentation(createInitialPresentationState(), {
      type: "worker-changed",
      worker: {
        workerId: "worker:queued",
        state: "queued",
        active: 1,
        queued: 2,
        maxActive: 4,
        planStepId: "step-research",
        taskLabel: "Research",
        timestamp: 1_000,
      },
    });
    state = reducePresentation(state, {
      type: "chrome-changed",
      chrome: { authority: "runtime", title: "Octocode", trust: "trusted" },
    });
    controller.render(state);

    const worker = [...adapter.states.values()].find(
      ({ kind }) => kind === "worker.progress",
    );
    expect(worker?.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "state", text: "○ QUEUED" }),
      ]),
    );
    expect(worker?.regions.some(({ id }) => id === "assignment" || id === "capacity")).toBe(false);
    const footer = [...adapter.states.values()].find(
      ({ kind }) => kind === "footer",
    );
    expect(footer?.regions[0]?.text).toContain("1/4 subagent active");
    expect(footer?.regions[0]?.text).toContain("2 queued");
    expect(controller.alternateOutput()).not.toContain("Research");
    expect(controller.alternateOutput()).not.toContain("step-research");
    expect(controller.alternateOutput()).not.toContain("worker:queued");
  });

  it("replaces the plan projection when session identity changes and removes it when cleared", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = withRuntimeWidgets(createInitialPresentationState());
    controller.render(state);

    state = reducePresentation(state, {
      type: "runtime-widgets-changed",
      snapshots: {
        plan: {
          authority: "runtime",
          planId: "plan-2",
          scope: { sessionId: "session-2", workspace: "/workspace" },
          revision: 1,
          phase: "active",
          steps: [
            { id: "step-2", text: "Continue elsewhere", status: "doing" },
          ],
        },
      },
    });
    expect(() => controller.render(state)).not.toThrow();
    expect(controller.alternateOutput()).toContain("Plan plan-2");

    state = reducePresentation(state, {
      type: "runtime-widgets-changed",
      snapshots: { plan: null },
    });
    controller.render(state);
    expect(controller.alternateOutput()).not.toContain("Plan plan-2");
  });

  it("keeps focus traversal bounded when tool history grows", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = createInitialPresentationState();
    for (let index = 0; index < 100; index += 1) {
      state = reducePresentation(state, {
        type: "tool-started",
        callId: `call-${index}`,
        name: `tool-${index}`,
      });
      state = reducePresentation(state, {
        type: "tool-result",
        callId: `call-${index}`,
        name: `tool-${index}`,
        result: `result-${index}`,
      });
    }
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "call-active",
      name: "active-tool",
    });
    for (let index = 0; index < 20; index += 1) {
      state = reducePresentation(state, {
        type: "presentation-changed",
        property: "widget",
        value: {
          id: `surface-${index}`,
          kind: "text",
          text: `surface ${index}`,
        },
      });
    }
    controller.render(withRuntimeWidgets(state));

    const focusable = controller.getFocusableWidgetIds();
    expect(focusable.length).toBeLessThanOrEqual(5);
    expect(
      focusable.filter(
        (id) => adapter.states.get(id)?.kind === "tool.progress",
      ),
    ).toHaveLength(1);
    expect(
      adapter.states
        .get(
          focusable.find(
            (id) => adapter.states.get(id)?.kind === "tool.progress",
          )!,
        )
        ?.regions.some(({ text }) => text.includes("active-tool")),
    ).toBe(true);
  });

  it("projects every typed surface without inferring trusted chrome, and merges every status source", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = createInitialPresentationState();
    for (const value of [
      { id: "text", kind: "text", text: "Generic text" },
      { id: "list", kind: "list", title: "Choices", items: ["One", "Two"] },
      {
        id: "facts",
        kind: "key-value",
        rows: [{ label: "Model", value: "native" }],
      },
      {
        id: "progress",
        kind: "progress",
        label: "Checks",
        current: 2,
        total: 3,
      },
    ] as const) {
      state = reducePresentation(state, {
        type: "presentation-changed",
        property: "widget",
        value,
      });
    }
    state = reducePresentation(state, {
      type: "status-changed",
      name: "model",
      text: "ready",
    });
    state = reducePresentation(state, {
      type: "notification",
      severity: "error",
      message: "Provider failed",
    });
    state = reducePresentation(state, {
      type: "runtime-widgets-changed",
      snapshots: {
        statusNotifications: [
          {
            authority: "runtime",
            slot: "agent",
            id: "structured",
            message: "Structured remains",
            lifecycle: "success",
          },
        ],
      },
    });

    controller.render(state);
    expect(
      [...adapter.states.values()].filter(
        ({ kind }) => kind === "presentation-surface",
      ),
    ).toHaveLength(4);
    expect(
      [...adapter.states.values()].some(
        ({ kind }) => kind === "header" || kind === "footer",
      ),
    ).toBe(false);
    const alternate = controller.alternateOutput();
    expect(alternate).toContain("Generic text");
    expect(alternate).toContain("model: ready");
    expect(alternate).toContain("Provider failed");
    expect(alternate).toContain("Structured remains");
    expect(controller.drainAnnouncements()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "ERROR: Provider failed",
          politeness: "assertive",
        }),
        expect.objectContaining({
          text: "SUCCESS: Structured remains",
          politeness: "polite",
        }),
      ]),
    );
  });

  it("keeps transient notification chrome recent while alternate output retains history", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = createInitialPresentationState();
    for (let index = 0; index < 10; index += 1) {
      state = reducePresentation(state, {
        type: "notification",
        severity: "info",
        message: `notice ${index}`,
      });
    }
    controller.render(state);

    const status = [...adapter.states.values()].find(
      ({ kind }) => kind === "status.notifications",
    );
    expect(
      status?.regions.filter(({ role }) => role === "option"),
    ).toHaveLength(3);
    const alternate = controller.alternateOutput();
    expect(alternate.match(/notice 0/gu)).toHaveLength(1);
    expect(alternate.match(/notice 9/gu)).toHaveLength(1);
  });

  it("projects the renderer-neutral worker inbox and dispatches only a current typed inspect intent", async () => {
    const adapter = new RecordingAdapter();
    const workerOperation = vi.fn(async () => undefined);
    const controller = new SemanticWidgetController(adapter, undefined, { workerOperation });
    const state = reducePresentation(createInitialPresentationState(), {
      type: "worker-inbox-changed",
      inbox: {
        authority: "runtime",
        generation: 7,
        capturedAt: 100,
        workers: [{
          workerId: "worker-1",
          state: "running",
          queueDepth: 0,
          availableActions: ["inspect", "send", "follow-up", "steer", "abort"],
          forceKillAvailable: true,
        }],
      },
    });
    controller.render(state);
    const inbox = [...adapter.states.values()].find(({ kind }) => kind === "worker-operations");
    expect(inbox).toBeDefined();
    expect(controller.alternateOutput()).toContain("Force kill (approval required)");
    expect(controller.focusWidget(inbox!.id)).toBe(true);
    expect(controller.handleFocusedNavigation("enter")).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(workerOperation).toHaveBeenCalledWith({
      type: "inspect",
      expectedGeneration: 7,
      workerId: "worker-1",
    });
  });

  it("bounds the global announcement drain while retaining assertive failures and newest work", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = createInitialPresentationState();
    for (let index = 0; index < 100; index += 1) {
      state = reducePresentation(state, {
        type: "tool-started",
        callId: `call-${index}`,
        name: `tool-${index}`,
      });
    }
    state = reducePresentation(state, {
      type: "notification",
      severity: "error",
      message: "Provider failed decisively",
    });
    controller.render(state);

    const announcements = controller.drainAnnouncements();
    expect(announcements.length).toBeLessThanOrEqual(32);
    expect(announcements).toContainEqual(
      expect.objectContaining({
        politeness: "assertive",
        text: "ERROR: Provider failed decisively",
      }),
    );
    expect(announcements.some(({ source }) => source === "tool:call-99")).toBe(
      true,
    );
    expect(controller.drainAnnouncements()).toEqual([]);
  });

  it("focuses and navigates every read-only surface, preserves plan position, and resizes chrome from the viewport", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter, {
      widthColumns: 80,
      heightRows: 14,
    });
    let state = withRuntimeWidgets(createInitialPresentationState());
    state = reducePresentation(state, {
      type: "presentation-changed",
      property: "widget",
      value: {
        id: "notes",
        kind: "list",
        items: Array.from({ length: 12 }, (_, index) => `Item ${index + 1}`),
      },
    });
    controller.render(state);
    const ids = controller.getFocusableWidgetIds();
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      expect(controller.focusWidget(id)).toBe(true);
      expect(adapter.states.get(id)?.focused).toBe(true);
      controller.handleFocusedNavigation("end");
    }
    expect(adapter.navigation.map(({ id }) => id)).toEqual(ids);
    const planId = ids.find((id) => adapter.states.get(id)?.kind === "plan")!;
    const planBefore = adapter.states.get(planId)?.revision;
    controller.resize({
      widthColumns: 32,
      heightRows: 12,
      reducedMotion: true,
    });
    expect(
      adapter.states
        .get("header")
        ?.regions[0]?.text.split("\n")
        .every((line) => line.length <= 32),
    ).toBe(true);
    expect(
      adapter.states
        .get("footer")
        ?.regions.every(({ text }) => text.length <= 32),
    ).toBe(true);
    expect(adapter.states.get(planId)?.revision).toBeGreaterThan(
      planBefore ?? 0,
    );
    controller.focusWidget(undefined);
    expect(adapter.focusedId).toBeUndefined();
  });

  it("replaces each interaction by generation and uses every interactive widget class", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = createInitialPresentationState();
    const requests = [
      {
        type: "confirm" as const,
        message: "Proceed with the requested action?",
      },
      {
        type: "select" as const,
        message: "Choose an option",
        options: ["Alpha", "Beta"],
      },
      { type: "input" as const, message: "Provide a name", initial: "Ada" },
      {
        type: "editor" as const,
        message: "Edit response",
        initial: "Line one",
      },
    ];
    const expectedKinds = [
      "confirm",
      "prompt.select",
      "prompt.input",
      "prompt.editor",
    ];

    requests.forEach((request, index) => {
      state = reducePresentation(state, {
        type: "interaction-requested",
        request,
      });
      controller.render(state);
      expect(state.interaction?.generation).toBe(index + 1);
      expect(
        [...adapter.states.values()].some(
          ({ kind }) => kind === expectedKinds[index],
        ),
      ).toBe(true);
    });

    expect(adapter.destroyed).toEqual(
      expect.arrayContaining([
        "interaction-1",
        "interaction-2",
        "interaction-3",
      ]),
    );
    controller.destroy();
    expect(adapter.states.size).toBe(0);
  });

  it("renders workflow progress and instructions while Discuss resolves as a typed action", () => {
    const adapter = new RecordingAdapter();
    const resolutions: unknown[] = [];
    const controller = new SemanticWidgetController(adapter, undefined, {
      resolveInteraction: (generation, result) =>
        resolutions.push({ generation, result }),
    });
    const state = reducePresentation(createInitialPresentationState(), {
      type: "interaction-requested",
      request: {
        type: "select",
        message: "Choose the storage boundary",
        options: ["Rust", "TypeScript"],
        workflow: {
          workflowId: "ask-1",
          questionId: "storage",
          index: 1,
          total: 3,
          title: "Architecture",
          instructions: "Prefer evidence over guesses.",
          allowDiscuss: true,
        },
      },
    });

    controller.render(state);
    const rendered = adapter.states.get("interaction-1");
    expect(rendered?.accessibility.label).toBe("Choose the storage boundary");
    expect(rendered?.regions).toContainEqual(
      expect.objectContaining({
        id: "description",
        text: expect.stringContaining("Architecture · Question 2 of 3"),
      }),
    );
    expect(rendered?.accessibility.description).toContain(
      "Prefer evidence over guesses.",
    );
    controller.handleNativeInteraction(1, { type: "discuss" });
    expect(resolutions).toEqual([
      { generation: 1, result: { status: "discuss" } },
    ]);
  });

  it("projects workflow chrome through every primitive widget without changing question content", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter);
    let state = createInitialPresentationState();
    const workflow = {
      workflowId: "ask-matrix",
      questionId: "question",
      index: 0,
      total: 2,
      title: "Design",
      instructions: "Explain uncertainty.",
      allowDiscuss: true,
    };
    const cases = [
      {
        request: { type: "confirm" as const, message: "Proceed?", workflow },
        region: "consequence",
      },
      {
        request: {
          type: "select" as const,
          message: "Choose",
          options: ["A", "B"],
          workflow,
        },
        region: "description",
      },
      {
        request: { type: "input" as const, message: "Name", workflow },
        region: "help",
      },
      {
        request: {
          type: "editor" as const,
          message: "Explain",
          initial: "",
          workflow,
        },
        region: "help",
      },
    ];

    cases.forEach(({ request, region }, index) => {
      state = reducePresentation(state, {
        type: "interaction-requested",
        request,
      });
      controller.render(state);
      const rendered = adapter.states.get(`interaction-${index + 1}`);
      expect(rendered?.regions.find(({ id }) => id === region)?.text).toContain(
        "Design · Question 1 of 2",
      );
      expect(rendered?.regions.find(({ id }) => id === region)?.text).toContain(
        "Explain uncertainty.",
      );
      expect(
        rendered?.regions.find(({ role }) => role === "prompt")?.text,
      ).toBe(request.message);
    });
  });

  it("routes native changes and submits through typed widget intents while stale generations no-op", () => {
    const adapter = new RecordingAdapter();
    const resolutions: unknown[] = [];
    const controller = new SemanticWidgetController(adapter, undefined, {
      resolveInteraction: (generation, result) =>
        resolutions.push({ generation, result }),
      interactionWidgetFactory: (interaction) =>
        new PromptInputWidget({
          id: `interaction-${interaction.generation}`,
          question: "Lowercase name",
          required: true,
          maxLength: 5,
          pattern: /^[a-z]+$/u,
          patternDescription: "Use lowercase letters only.",
        }),
    });
    let state = reducePresentation(createInitialPresentationState(), {
      type: "interaction-requested",
      request: { type: "input", message: "Lowercase name" },
    });
    controller.render(state);

    controller.handleNativeInteraction(1, { type: "input-submit", value: "" });
    expect(adapter.states.get("interaction-1")?.regions).toContainEqual(
      expect.objectContaining({
        id: "validation",
        text: "A value is required.",
      }),
    );
    controller.handleNativeInteraction(1, {
      type: "input-submit",
      value: "ABC",
    });
    expect(adapter.states.get("interaction-1")?.regions).toContainEqual(
      expect.objectContaining({
        id: "validation",
        text: "Use lowercase letters only.",
      }),
    );
    controller.handleNativeInteraction(1, {
      type: "input-change",
      value: "abcdef",
    });
    expect(adapter.states.get("interaction-1")?.regions).toContainEqual(
      expect.objectContaining({
        id: "validation",
        text: "Enter no more than 5 characters.",
      }),
    );
    controller.handleNativeInteraction(0, {
      type: "input-submit",
      value: "stale",
    });
    controller.handleNativeInteraction(1, {
      type: "input-change",
      value: "ada",
    });
    expect(resolutions).toEqual([]);
    controller.handleNativeInteraction(1, {
      type: "input-submit",
      value: "ada",
    });
    expect(resolutions).toEqual([
      { generation: 1, result: { status: "accepted", value: "ada" } },
    ]);
  });

  it("uses stable select IDs for all options, rejects disabled choices, and confirms through typed intents", () => {
    const adapter = new RecordingAdapter();
    const resolutions: unknown[] = [];
    let mode: "select" | "confirm" = "select";
    const controller = new SemanticWidgetController(adapter, undefined, {
      resolveInteraction: (generation, result) =>
        resolutions.push({ generation, result }),
      interactionWidgetFactory: (interaction) =>
        mode === "select"
          ? new SelectWidget({
              id: `interaction-${interaction.generation}`,
              label: "Choose",
              consequential: true,
              options: Array.from({ length: 12 }, (_, index) => ({
                id: `choice-${index + 1}`,
                label: `Option ${index + 1}`,
                ...(index === 9 ? { disabledReason: "Unavailable" } : {}),
              })),
            })
          : new ConfirmWidget({
              id: `interaction-${interaction.generation}`,
              authority: "runtime",
              question: "Proceed?",
              consequence: "Runs the action once.",
            }),
    });
    let state = reducePresentation(createInitialPresentationState(), {
      type: "interaction-requested",
      request: {
        type: "select",
        message: "Choose",
        options: Array.from(
          { length: 12 },
          (_, index) => `Option ${index + 1}`,
        ),
      },
    });
    controller.render(state);
    expect(
      (adapter.binding?.widget as SelectWidget).nativeOptions,
    ).toHaveLength(12);
    controller.handleNativeInteraction(1, {
      type: "select-submit",
      optionId: "choice-10",
    });
    expect(resolutions).toEqual([]);
    controller.handleNativeInteraction(1, {
      type: "select-submit",
      optionId: "choice-12",
    });
    expect(resolutions).toEqual([
      { generation: 1, result: { status: "accepted", value: "Option 12" } },
    ]);

    mode = "confirm";
    state = reducePresentation(state, {
      type: "interaction-resolved",
      result: { status: "cancelled" },
    });
    state = reducePresentation(state, {
      type: "interaction-requested",
      request: { type: "confirm", message: "Proceed?" },
    });
    controller.render(state);
    controller.handleNativeInteraction(2, { type: "confirm-submit", index: 0 });
    expect(resolutions.at(-1)).toEqual({
      generation: 2,
      result: { status: "accepted", value: true },
    });
  });

  it("fails closed for status actions without a host sink and dispatches validated actions asynchronously when enabled", async () => {
    const snapshots = {
      statusNotifications: [
        {
          authority: "runtime" as const,
          slot: "system" as const,
          id: "retry-provider",
          message: "Provider connection failed",
          lifecycle: "error" as const,
          action: { id: "retry", label: "Retry connection" },
        },
      ],
    };
    const state = reducePresentation(createInitialPresentationState(), {
      type: "runtime-widgets-changed",
      snapshots,
    });

    const closedAdapter = new RecordingAdapter();
    const closed = new SemanticWidgetController(closedAdapter);
    closed.render(state);
    expect(closed.alternateOutput()).not.toContain("Retry connection");
    expect(
      closedAdapter.states.get("status-notifications")?.regions.join(" "),
    ).not.toContain("Retry connection");
    expect(closed.focusWidget("status-notifications")).toBe(true);
    expect(closed.handleFocusedNavigation("enter")).toBe(true);

    const actions: unknown[] = [];
    const enabled = new SemanticWidgetController(
      new RecordingAdapter(),
      undefined,
      {
        statusAction: (invocation) => {
          actions.push(invocation);
        },
      },
    );
    enabled.render(state);
    expect(enabled.alternateOutput()).toContain("Retry connection");
    expect(enabled.focusWidget("status-notifications")).toBe(true);
    expect(enabled.handleFocusedNavigation("enter")).toBe(true);
    expect(actions).toEqual([]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(actions).toEqual([
      {
        key: "system:retry-provider",
        action: { id: "retry", label: "Retry connection" },
      },
    ]);
  });

  it("announces each interaction and validation once without exposing the input buffer", () => {
    const adapter = new RecordingAdapter();
    const controller = new SemanticWidgetController(adapter, undefined, {
      interactionWidgetFactory: (interaction) =>
        new PromptInputWidget({
          id: `interaction-${interaction.generation}`,
          question: "API token",
          help: "Enter the required credential.",
          required: true,
        }),
    });
    let state = reducePresentation(createInitialPresentationState(), {
      type: "interaction-requested",
      request: { type: "confirm", message: "Delete the session?" },
    });
    const confirmController = new SemanticWidgetController(
      new RecordingAdapter(),
    );
    confirmController.render(state);
    expect(confirmController.drainAnnouncements()).toContainEqual(
      expect.objectContaining({
        source: "interaction:interaction-1",
        politeness: "assertive",
      }),
    );
    expect(confirmController.drainAnnouncements()).toEqual([]);

    state = reducePresentation(createInitialPresentationState(), {
      type: "interaction-requested",
      request: {
        type: "input",
        message: "API token",
        initial: "secret-buffer-value",
      },
    });
    controller.render(state);
    const prompt = controller.drainAnnouncements();
    expect(prompt).toContainEqual(
      expect.objectContaining({
        source: "interaction:interaction-1",
        politeness: "polite",
        text: "API token. Enter the required credential.",
      }),
    );
    expect(JSON.stringify(prompt)).not.toContain("secret-buffer-value");
    controller.handleNativeInteraction(1, { type: "input-submit", value: "" });
    controller.handleNativeInteraction(1, { type: "input-submit", value: "" });
    expect(
      controller
        .drainAnnouncements()
        .filter(({ source }) => source.endsWith(":validation")),
    ).toEqual([
      {
        source: "interaction:interaction-1:validation",
        politeness: "polite",
        text: "A value is required.",
      },
    ]);
    expect(controller.drainAnnouncements()).toEqual([]);
  });

  it("uses the injected clock to throttle material tool progress announcements", () => {
    const ticks = [1_000, 2_000, 2_600];
    const controller = new SemanticWidgetController(
      new RecordingAdapter(),
      undefined,
      {
        nowMs: () => ticks.shift() ?? 2_600,
      },
    );
    let state = reducePresentation(createInitialPresentationState(), {
      type: "tool-started",
      callId: "call-clock",
      name: "clockedTool",
    });
    controller.render(state);
    expect(controller.drainAnnouncements()).toContainEqual(
      expect.objectContaining({
        source: "tool:call-clock",
        text: expect.stringContaining("started"),
      }),
    );

    state = reducePresentation(state, {
      type: "tool-updated",
      callId: "call-clock",
      current: 4,
      total: 100,
    });
    controller.render(state);
    expect(controller.drainAnnouncements()).toEqual([]);
    state = reducePresentation(state, {
      type: "tool-updated",
      callId: "call-clock",
      current: 10,
      total: 100,
    });
    controller.render(state);
    expect(controller.drainAnnouncements()).toContainEqual(
      expect.objectContaining({
        source: "tool:call-clock",
        text: "Tool clockedTool progress: 10/100 (call-clock).",
      }),
    );
  });

  it("uses the injected wall clock for status timestamps", () => {
    const timestamp = Date.UTC(2026, 7, 28, 10, 0, 0);
    const controller = new SemanticWidgetController(
      new RecordingAdapter(),
      undefined,
      {
        nowMs: () => timestamp,
      },
    );
    const state = reducePresentation(createInitialPresentationState(), {
      type: "notification",
      severity: "warning",
      message: "Context nearly full",
    });

    controller.render(state);

    expect(controller.alternateOutput()).toContain("2026-08-28T10:00:00.000Z");
    expect(controller.alternateOutput()).not.toContain("1970-01-01");
  });
});
