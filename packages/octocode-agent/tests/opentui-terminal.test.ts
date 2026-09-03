import { describe, expect, it, vi } from "vitest";

import {
  createInitialPresentationState,
  createOpenTuiUiPort,
  formatPresentationFrame,
  formatPresentationSections,
  MAX_PRESENTATION_MESSAGES,
  MAX_PRESENTATION_TOOLS,
  parsePresentationWidget,
  projectPresentationChrome,
  reducePresentation,
  type OpenTuiRendererEvents,
} from "../src/terminal/opentui/presentation.js";
import {
  createOpenTuiStore,
  type OpenTuiStore,
} from "../src/terminal/opentui/state/view-store.js";
import { createOpenTuiTerminal } from "../src/terminal/opentui/create-terminal.js";

describe("OpenTUI presentation projection", () => {
  it("owns runtime chrome facts in presentation state and projects viewport-specific widgets", () => {
    const plan = {
      authority: "runtime" as const,
      planId: "plan:stable",
      scope: { sessionId: "session-1", workspace: "/workspace" },
      revision: 1,
      phase: "active" as const,
      steps: [{ id: "step-1", text: "Build", status: "doing" as const }],
    };
    const notifications = [
      {
        authority: "runtime" as const,
        slot: "system" as const,
        id: "sync",
        message: "Synced",
        lifecycle: "success" as const,
      },
    ];

    let state = reducePresentation(createInitialPresentationState(), {
      type: "chrome-changed",
      chrome: {
        authority: "runtime",
        title: "Octocode",
        modelId: "gpt-5",
        sessionId: "session-1",
        trust: "trusted",
      },
    });
    state = reducePresentation(state, { type: "runtime-ready" });
    state = reducePresentation(state, {
      type: "turn-started",
      turnId: "turn-1",
    });
    state = reducePresentation(state, { type: "plan-changed", plan });
    state = reducePresentation(state, {
      type: "runtime-widgets-changed",
      snapshots: { statusNotifications: notifications },
    });

    const narrow = projectPresentationChrome(state, 40);
    const wide = projectPresentationChrome(state, 120);
    expect(state.chrome).toEqual({
      authority: "runtime",
      title: "Octocode",
      modelId: "gpt-5",
      sessionId: "session-1",
      trust: "trusted",
      connection: "connected",
    });
    expect(state.runtimeWidgets).toEqual({
      plan,
      statusNotifications: notifications,
    });
    state = reducePresentation(state, { type: "plan-changed", plan: null });
    expect(state.runtimeWidgets).toEqual({
      statusNotifications: notifications,
    });
    expect(narrow?.header).toMatchObject({ working: state.working, width: 40 });
    expect(narrow?.footer).toMatchObject({
      activeMode: "chat",
      connection: "connected",
      widthColumns: 40,
    });
    expect(narrow?.footer.keyHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "Enter", label: "Follow up" }),
        expect.objectContaining({ key: "Esc/Ctrl-C", label: "Cancel turn" }),
        expect.objectContaining({ key: "/steer", label: "Redirect" }),
      ]),
    );
    expect(wide?.header.width).toBe(120);
    expect(state.chrome).not.toHaveProperty("width");
    expect(state.chrome).not.toHaveProperty("keyHints");
  });

  it("resets stale context usage while preserving the visible transcript when context is cleared", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "chrome-changed",
      chrome: {
        authority: "runtime",
        title: "Octocode",
        sessionId: "session-1",
        trust: "trusted",
      },
    });
    state = reducePresentation(state, { type: "runtime-ready" });
    state = reducePresentation(state, {
      type: "turn-started",
      turnId: "turn-1",
    });
    state = reducePresentation(state, {
      type: "user-message",
      text: "old context",
      turnId: "turn-1",
    });
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "call-1",
      name: "lookup",
    });
    state = reducePresentation(state, {
      type: "context-usage-changed",
      used: 42,
      limit: 100,
      inputTokens: 42,
      outputTokens: 8,
    });
    state = reducePresentation(state, {
      type: "presentation-changed",
      property: "widget",
      value: { id: "native-command-output", kind: "text", text: "old output" },
    });

    const cleared = reducePresentation(state, { type: "context-cleared" });

    expect(cleared).toMatchObject({
      ready: true,
      working: "idle",
      activeTurnId: undefined,
      statuses: {},
      contextUsage: undefined,
    });
    expect(cleared.turns).toEqual(state.turns);
    expect(cleared.messages).toEqual(state.messages);
    expect(cleared.tools).toEqual(state.tools);
    expect(cleared.widgets).toEqual(state.widgets);
    expect(cleared.chrome).toEqual(state.chrome);
  });

  it("clears session-owned transcript state before hydrating another session", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "user-message",
      messageId: "session-a-message",
      text: "from session A",
    });
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "session-a-tool",
      name: "lookup",
    });

    const cleared = reducePresentation(state, { type: "transcript-cleared" });

    expect(cleared.messages).toEqual([]);
    expect(cleared.turns).toEqual([]);
    expect(cleared.tools).toEqual([]);
    expect(cleared.workers).toEqual([]);
    expect(cleared.notifications).toEqual([]);
  });

  it("clears old-generation statuses and notifications before retaining the new receipt", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "status-changed",
      name: "provider",
      text: "Waiting for the old provider",
    });
    state = reducePresentation(state, {
      type: "notification",
      severity: "error",
      message: "Old generation failed",
    });

    state = reducePresentation(state, { type: "session-replaced" });
    state = reducePresentation(state, {
      type: "notification",
      severity: "success",
      message: "Private session · abc12345 · Resumed",
    });

    expect(state.statuses).toEqual({});
    expect(state.notifications).toEqual([
      {
        severity: "success",
        message: "Private session · abc12345 · Resumed",
      },
    ]);
  });

  it("coalesces interleaved worker generations independently and preserves terminal failures", () => {
    let state = createInitialPresentationState();
    for (const event of [
      { type: "notification", severity: "error", message: "Subagent · FAILED", key: "worker:alpha" },
      { type: "notification", severity: "info", message: "Provider retrying" },
      { type: "notification", severity: "success", message: "Subagent · SUCCEEDED", key: "worker:beta" },
      { type: "notification", severity: "warning", message: "Subagent · ABORTED", key: "worker:beta" },
    ] as const) {
      state = reducePresentation(state, event);
    }

    expect(state.notifications).toEqual([
      { severity: "error", message: "Subagent · FAILED", key: "worker:alpha" },
      { severity: "info", message: "Provider retrying", key: "provider" },
      { severity: "warning", message: "Subagent · ABORTED", key: "worker:beta" },
    ]);

    state = reducePresentation(state, {
      type: "chrome-changed",
      chrome: { authority: "runtime", title: "Octocode", trust: "trusted" },
    });
    state = reducePresentation(state, {
      type: "worker-changed",
      worker: { workerId: "alpha", state: "failed", timestamp: 1 },
    });
    expect(projectPresentationChrome(state, 40)?.footer.activitySummary).toEqual({
      text: "Action failed · inspect Activity",
      tone: "error",
    });
  });

  it("retains the newest fifty notifications in burst order", () => {
    let state = createInitialPresentationState();
    for (let index = 0; index < 55; index += 1) {
      state = reducePresentation(state, {
        type: "notification",
        severity: "info",
        message: `Burst ${index}`,
      });
    }
    expect(state.notifications).toHaveLength(50);
    expect(state.notifications[0]?.message).toBe("Burst 5");
    expect(state.notifications.at(-1)?.message).toBe("Burst 54");
  });

  it("projects authoritative context remaining and runtime facts into the footer", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "chrome-changed",
      chrome: {
        authority: "runtime",
        title: "Octocode",
        modelId: "claude-sonnet-4-6",
        trust: "trusted",
        permissionMode: "default",
      },
    });
    state = reducePresentation(state, {
      type: "context-usage-changed",
      used: 24_000,
      limit: 200_000,
      inputTokens: 24_000,
      outputTokens: 1_500,
      cachedInputTokens: 4_000,
      cacheWriteInputTokens: 500,
    });

    expect(projectPresentationChrome(state, 160)?.footer).toMatchObject({
      contextUsage: { used: 24_000, limit: 200_000 },
      modelId: "claude-sonnet-4-6",
      trust: "trusted",
      permissionMode: "default",
    });
    expect(state.statuses["context.usage"]).toBe(
      "24,000 input · 1,500 output · 4,000 cached · 500 cache write tokens",
    );
  });

  it("keeps the active lifecycle phase visible in the persistent footer", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "chrome-changed",
      chrome: { authority: "runtime", title: "Octocode", trust: "trusted" },
    });
    state = reducePresentation(state, {
      type: "status-changed",
      name: "provider",
      text: "Waiting for model · attempt 1/3",
    });

    expect(projectPresentationChrome(state, 120)?.footer.activitySummary).toEqual({
      text: "Waiting for model · attempt 1/3",
      tone: "info",
    });
  });

  it("keeps the required action first when every footer priority overlaps", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "chrome-changed",
      chrome: { authority: "runtime", title: "Octocode", trust: "trusted" },
    });
    for (const [name, text] of [
      ["provider", "Waiting for model"],
      ["trust", "Resolving trust"],
      ["resources", "Discovering resources"],
      ["session", "Switching session"],
      ["context.compaction", "Compacting context"],
    ] as const) {
      state = reducePresentation(state, { type: "status-changed", name, text });
    }
    state = reducePresentation(state, {
      type: "plan-changed",
      plan: {
        authority: "runtime",
        planId: "plan-overlap",
        scope: { sessionId: "session-overlap", workspace: "/workspace" },
        revision: 1,
        phase: "active",
        steps: [{ id: "step-1", text: "Implement", status: "doing" }],
      },
    });
    state = reducePresentation(state, {
      type: "worker-changed",
      worker: {
        workerId: "worker-overlap",
        state: "running",
        active: 1,
        queued: 1,
        maxActive: 4,
        timestamp: 1,
      },
    });
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "tool-running",
      name: "search",
    });
    state = reducePresentation(state, {
      type: "tool-prepared",
      callId: "tool-blocked",
      name: "write",
    });
    state = reducePresentation(state, {
      type: "tool-blocked",
      callId: "tool-blocked",
      name: "write",
      message: "policy blocked",
    });
    state = reducePresentation(state, {
      type: "tool-prepared",
      callId: "tool-failed",
      name: "exec",
    });
    state = reducePresentation(state, {
      type: "tool-failed",
      callId: "tool-failed",
      name: "exec",
      message: "exit 1",
      category: "tool-execution",
    });
    state = reducePresentation(state, {
      type: "runtime-widgets-changed",
      snapshots: {
        statusNotifications: [
          {
            authority: "runtime",
            slot: "permission",
            id: "approval-overlap",
            message: "Approval required for protected action",
            lifecycle: "active",
          },
        ],
      },
    });

    expect(projectPresentationChrome(state, 40)?.footer.activitySummary).toEqual({
      text: "Approval required",
      tone: "warning",
    });
    expect(projectPresentationChrome(state, 160)?.footer.activitySummary).toEqual({
      text: "Approval required",
      tone: "warning",
    });
  });

  it("derives interaction mode from canonical interaction state without a chrome rewrite", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "chrome-changed",
      chrome: { authority: "runtime", title: "Octocode", trust: "unknown" },
    });
    state = reducePresentation(state, {
      type: "interaction-requested",
      request: { type: "confirm", message: "Continue?" },
    });
    expect(projectPresentationChrome(state, 80)?.footer).toMatchObject({
      activeMode: "respond",
    });
    state = reducePresentation(state, {
      type: "interaction-resolved",
      result: { status: "accepted", value: true },
    });
    expect(projectPresentationChrome(state, 80)?.footer).toMatchObject({
      activeMode: "chat",
    });
  });

  it("owns footer key hints per active interaction type", () => {
    const chrome = reducePresentation(createInitialPresentationState(), {
      type: "chrome-changed",
      chrome: { authority: "runtime", title: "Octocode", trust: "unknown" },
    });
    const hintsFor = (
      request: Parameters<typeof reducePresentation>[1] & {
        type: "interaction-requested";
      },
    ) =>
      projectPresentationChrome(reducePresentation(chrome, request), 120)
        ?.footer.keyHints;

    expect(
      hintsFor({
        type: "interaction-requested",
        request: { type: "confirm", message: "Continue?" },
      }),
    ).toEqual([
      { key: "Enter", label: "Choose", priority: 1 },
      { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
      { key: "Tab", label: "Move choice", priority: 3 },
    ]);
    expect(
      hintsFor({
        type: "interaction-requested",
        request: {
          type: "select",
          message: "Choose",
          options: ["Alpha", "Beta"],
        },
      }),
    ).toEqual([
      { key: "Enter", label: "Choose", priority: 1 },
      { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
      { key: "↑/↓", label: "Move choice", priority: 3 },
    ]);
    expect(
      hintsFor({
        type: "interaction-requested",
        request: { type: "input", message: "Name" },
      }),
    ).toEqual([
      { key: "Enter", label: "Submit", priority: 1 },
      { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
    ]);
    expect(
      hintsFor({
        type: "interaction-requested",
        request: { type: "editor", message: "Explain", initial: "" },
      }),
    ).toEqual([
      { key: "Meta-Enter", label: "Submit", priority: 1 },
      { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
    ]);
  });

  it("formats complete workflow context for alternate renderers", () => {
    const state = reducePresentation(createInitialPresentationState(), {
      type: "interaction-requested",
      request: {
        type: "input",
        message: "Which boundary owns persistence?",
        workflow: {
          workflowId: "ask-1",
          questionId: "persistence",
          index: 1,
          total: 3,
          title: "Architecture",
          instructions: "Discuss uncertain tradeoffs first.",
          allowDiscuss: true,
        },
      },
    });

    expect(formatPresentationSections(state).sidebar).toContain(
      [
        "Architecture · Question 2 of 3",
        "Which boundary owns persistence?",
        "Discuss uncertain tradeoffs first.",
        "Actions: answer · discuss · cancel",
      ].join("\n"),
    );
  });

  it("rejects malformed or renderer-unsupported interaction data before presentation state changes", async () => {
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy: () => undefined,
        render: () => undefined,
      }),
    });
    await terminal.start();
    const tooManyOptions = Array.from(
      { length: 51 },
      (_, index) => `Option ${index + 1}`,
    );
    await expect(
      terminal.interact!(
        {
          type: "select",
          message: "Too many",
          options: tooManyOptions,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "unsupported" });
    await expect(
      terminal.interact!(
        {
          type: "input",
          message: "Broken workflow",
          workflow: {
            workflowId: "ask-1",
            questionId: "broken",
            index: 3,
            total: 3,
            allowDiscuss: true,
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "unsupported" });
    expect(terminal.snapshot().interaction).toBeUndefined();
    await terminal.stop();
  });

  it("copies workflow event data before storing presentation state", () => {
    const workflow = {
      workflowId: "ask-1",
      questionId: "copy",
      index: 0,
      total: 1,
      title: "Original",
      allowDiscuss: true,
    };
    const state = reducePresentation(createInitialPresentationState(), {
      type: "interaction-requested",
      request: { type: "input", message: "Copy?", workflow },
    });
    workflow.title = "Mutated";
    expect(state.interaction?.request.workflow?.title).toBe("Original");
  });

  it("reduces semantic events without toolkit values entering state", () => {
    const initial = createInitialPresentationState();
    const ready = reducePresentation(initial, { type: "runtime-ready" });
    const streaming = reducePresentation(ready, {
      type: "message-delta",
      text: "hello",
    });
    const notified = reducePresentation(streaming, {
      type: "notification",
      severity: "warning",
      message: "careful",
    });

    expect(notified).toEqual({
      ready: true,
      working: "idle",
      turns: [],
      messages: [
        {
          id: "assistant:unscoped",
          role: "assistant",
          status: "streaming",
          segments: [{ kind: "text", text: "hello" }],
        },
      ],
      tools: [],
      workers: [],
      statuses: {},
      notifications: [{ severity: "warning", message: "careful" }],
      widgets: {},
      interactionHandler: "required",
    });
    expect(JSON.stringify(notified)).not.toMatch(
      /renderer|renderable|opentui/i,
    );
  });

  it("destroys the renderer exactly once after normal stop", async () => {
    const destroy = vi.fn(async () => undefined);
    const render = vi.fn();
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({ destroy, render }),
    });

    await terminal.start();
    terminal.accept({ type: "runtime-ready" });
    await terminal.stop();
    await terminal.stop();

    expect(render).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("settles an interrupted stream and concurrent shutdown race exactly once", async () => {
    let releaseDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    const destroy = vi.fn(async () => destroyGate);
    const render = vi.fn();
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({ destroy, render }),
    });
    await terminal.start();
    terminal.accept({
      type: "message-started",
      messageId: "interrupted-stream",
      role: "assistant",
    });
    for (let index = 0; index < 100; index += 1) {
      terminal.accept({
        type: "message-delta",
        messageId: "interrupted-stream",
        text: String(index % 10),
      });
    }

    const first = terminal.stop();
    const second = terminal.stop();
    const third = terminal.stop();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(destroy).toHaveBeenCalledOnce();
    releaseDestroy();
    await Promise.all([first, second, third]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]?.[0]).toMatchObject({
      messages: [
        expect.objectContaining({
          id: "interrupted-stream",
          status: "streaming",
        }),
      ],
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(() => terminal.accept({ type: "runtime-ready" })).toThrow(/stopped/i);
  });

  it("destroys a late renderer once when initialization races shutdown", async () => {
    let resolveRenderer!: (renderer: {
      destroy: () => Promise<void>;
      render: () => void;
    }) => void;
    const destroy = vi.fn(async () => undefined);
    const createRenderer = new Promise<{
      destroy: () => Promise<void>;
      render: () => void;
    }>((resolve) => {
      resolveRenderer = resolve;
    });
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => createRenderer,
    });

    const started = terminal.start();
    const stopped = terminal.stop();
    resolveRenderer({ destroy, render: () => undefined });
    await Promise.all([started, stopped]);

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cleans up after a render failure and reports the failure", async () => {
    const destroy = vi.fn(async () => undefined);
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy,
        render: () => {
          throw new Error("frame failed");
        },
      }),
    });
    const failure = new Promise<unknown>((resolve) =>
      terminal.subscribeFailure?.(resolve),
    );

    await terminal.start();
    terminal.accept({ type: "runtime-ready" });
    await expect(failure).resolves.toEqual(
      expect.objectContaining({ message: "frame failed" }),
    );
    await expect(terminal.stop()).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("coalesces presentation-only bursts into one renderer frame", async () => {
    const render = vi.fn();
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({ destroy: () => undefined, render }),
    });
    await terminal.start();

    for (let index = 0; index < 100; index += 1) {
      terminal.accept({
        type: "message-delta",
        messageId: "stream",
        text: String(index),
      });
    }
    expect(render).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(render).toHaveBeenCalledOnce();
    expect(terminal.snapshot().messages[0]?.segments[0]?.text).toContain("99");
    await terminal.stop();
  });

  it("passes one store to the renderer and ignores view-only updates", async () => {
    const render = vi.fn();
    let rendererStore: OpenTuiStore | undefined;
    const terminal = createOpenTuiTerminal({
      createRenderer: async (_events, store) => {
        rendererStore = store;
        return { destroy: () => undefined, render };
      },
    });
    await terminal.start();

    const initialPresentation = rendererStore?.getState().presentation;
    rendererStore?.getState().actions.resize(40, 18);
    rendererStore?.getState().actions.selectRailPane("activity");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(rendererStore?.getState().presentation).toBe(initialPresentation);
    expect(render).not.toHaveBeenCalled();

    terminal.accept({ type: "runtime-ready" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(render).toHaveBeenCalledOnce();
    await terminal.stop();
  });

  it("reports rejected renderer-input callbacks instead of swallowing them", async () => {
    let nativeEvents: OpenTuiRendererEvents | undefined;
    const terminal = createOpenTuiTerminal({
      inputOwnership: "renderer",
      createRenderer: async (events) => {
        nativeEvents = events;
        return { destroy: () => undefined, render: () => undefined };
      },
    });
    const failure = new Promise<unknown>((resolve) =>
      terminal.subscribeFailure?.(resolve),
    );
    terminal.subscribeInput?.(async () => {
      throw new Error("input callback failed");
    });
    await terminal.start();

    nativeEvents!.submitInput({ schemaVersion: 1, parts: [{ type: "text", text: "hello" }] });

    await expect(failure).resolves.toEqual(
      expect.objectContaining({ message: "input callback failed" }),
    );
    await terminal.stop();
  });

  it("propagates renderer callback failures through the terminal error boundary", async () => {
    let nativeEvents: OpenTuiRendererEvents | undefined;
    const terminal = createOpenTuiTerminal({
      createRenderer: async (events) => {
        nativeEvents = events;
        return { destroy: () => undefined, render: () => undefined };
      },
    });
    const failure = new Promise<unknown>((resolve) =>
      terminal.subscribeFailure?.(resolve),
    );
    await terminal.start();

    expect(nativeEvents).toBeDefined();
    nativeEvents?.failure?.(new Error("status callback failed"));

    await expect(failure).resolves.toEqual(
      expect.objectContaining({ message: "status callback failed" }),
    );
    await terminal.stop();
  });

  it("preserves fatal runtime state after the failed turn ends", () => {
    let state = reducePresentation(createInitialPresentationState(), {
      type: "turn-started",
      turnId: "turn-1",
    });
    state = reducePresentation(state, { type: "runtime-failed" });
    state = reducePresentation(state, {
      type: "turn-ended",
      turnId: "turn-1",
      outcome: "error",
    });

    expect(state.working).toBe("failed");
    expect(state.activeTurnId).toBeUndefined();
  });

  it("maps the canonical UiPort into semantic terminal events", async () => {
    const frames: unknown[] = [];
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy: () => undefined,
        render: (state) => frames.push(state),
      }),
    });
    await terminal.start();
    const ui = createOpenTuiUiPort(terminal);

    await ui.notify("hello", "info");
    await ui.setStatus("model", "ready");
    await ui.present({ type: "working", value: "cancelling" });

    expect(terminal.snapshot()).toMatchObject({
      working: "cancelling",
      statuses: { model: "ready" },
      interactionHandler: "ready",
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(4);
    const interaction = ui.interact(
      { type: "confirm", message: "continue?" },
      new AbortController().signal,
    );
    expect(terminal.acceptInput!("yes")).toBe(true);
    await expect(interaction).resolves.toEqual({
      status: "accepted",
      value: true,
    });
  });

  it("owns presentation data in the OpenTUI store and publishes immutable widget snapshots", () => {
    const store = createOpenTuiStore();
    const observed: unknown[] = [];
    store.subscribe((state) => observed.push(state.presentation));
    const items = ["audit", "implement"];

    store.getState().actions.accept({
      type: "presentation-changed",
      property: "widget",
      value: { id: "plan", kind: "list", title: "Plan", items },
    });
    items.push("mutated after dispatch");

    expect(store.getState().presentation.widgets).toEqual({
      plan: {
        id: "plan",
        kind: "list",
        title: "Plan",
        items: ["audit", "implement"],
      },
    });
    expect(observed).toHaveLength(1);

    store.getState().actions.accept({
      type: "presentation-changed",
      property: "widget",
      value: { id: "plan", remove: true },
    });
    expect(store.getState().presentation.widgets).toEqual({});
  });

  it("defensively copies plan and worker-inbox snapshots at presentation ingress", () => {
    const store = createOpenTuiStore();
    const scope = { sessionId: "session-1", workspace: "/workspace" };
    const dependsOn = ["step-0"];
    const steps = [{
      id: "step-1",
      text: "Implement",
      status: "doing" as const,
      dependsOn,
    }];
    const availableActions: ("inspect" | "send")[] = ["inspect"];
    const workers = [{
      workerId: "worker-1",
      state: "running" as const,
      queueDepth: 0,
      availableActions,
      forceKillAvailable: false,
    }];

    store.getState().actions.accept({
      type: "plan-changed",
      plan: {
        authority: "runtime",
        planId: "plan-1",
        scope,
        revision: 1,
        phase: "active",
        steps,
      },
    });
    store.getState().actions.accept({
      type: "worker-inbox-changed",
      inbox: {
        authority: "runtime",
        generation: 1,
        capturedAt: 1,
        workers,
      },
    });

    scope.workspace = "/mutated";
    steps[0]!.text = "Mutated";
    dependsOn.push("step-2");
    workers[0]!.queueDepth = 99;
    availableActions.push("send");

    expect(store.getState().presentation.runtimeWidgets?.plan).toMatchObject({
      scope: { workspace: "/workspace" },
      steps: [{ text: "Implement", dependsOn: ["step-0"] }],
    });
    expect(store.getState().presentation.workerInbox).toMatchObject({
      workers: [{ queueDepth: 0, availableActions: ["inspect"] }],
    });
  });

  it("renders typed widgets without stringifying arbitrary objects", () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: "presentation-changed",
      property: "widget",
      value: {
        id: "usage",
        kind: "key-value",
        title: "Usage",
        rows: [{ label: "tokens", value: "42" }],
      },
    });
    expect(
      parsePresentationWidget({
        id: "unsafe",
        kind: "text",
        text: { secret: true },
      }),
    ).toBeUndefined();

    expect(formatPresentationFrame(state)).toContain("Usage\ntokens: 42");
    expect(formatPresentationFrame(state)).not.toContain("[object Object]");
    expect(state.widgets).not.toHaveProperty("unsafe");
  });

  it("assembles bounded typed message records across explicit turn boundaries", () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: "input-received",
      messageId: "user-1",
      text: "show status",
    });
    state = reducePresentation(state, {
      type: "turn-started",
      turnId: "turn-1",
    });
    state = reducePresentation(state, {
      type: "message-started",
      messageId: "assistant-1",
      role: "assistant",
      turnId: "turn-1",
    });
    state = reducePresentation(state, {
      type: "message-delta",
      messageId: "assistant-1",
      turnId: "turn-1",
      segment: "thinking",
      text: "checking",
    });
    state = reducePresentation(state, {
      type: "message-delta",
      messageId: "assistant-1",
      turnId: "turn-1",
      text: "all green",
    });
    state = reducePresentation(state, {
      type: "message-ended",
      messageId: "assistant-1",
    });
    state = reducePresentation(state, {
      type: "turn-ended",
      turnId: "turn-1",
      outcome: "completed",
    });

    expect(state.working).toBe("idle");
    expect(state.activeTurnId).toBeUndefined();
    expect(state.turns).toEqual([{ id: "turn-1", status: "completed" }]);
    expect(state.messages).toEqual([
      {
        id: "user-1",
        role: "user",
        turnId: "turn-1",
        status: "complete",
        segments: [{ kind: "text", text: "show status" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        turnId: "turn-1",
        status: "complete",
        segments: [
          { kind: "thinking", text: "checking" },
          { kind: "text", text: "all green" },
        ],
      },
    ]);
    expect(formatPresentationFrame(state)).toContain("You\nshow status");
    expect(formatPresentationFrame(state)).toContain(
      "Assistant\nThinking…\nall green",
    );
    expect(formatPresentationFrame(state)).not.toContain("checking");

    for (let index = 0; index < MAX_PRESENTATION_MESSAGES + 5; index += 1) {
      state = reducePresentation(state, {
        type: "user-message",
        messageId: `bounded-${index}`,
        text: `message-${index}`,
      });
    }
    expect(state.messages).toHaveLength(MAX_PRESENTATION_MESSAGES);
    expect(state.messages[0]?.id).toBe("bounded-5");
  });

  it("projects the complete typed tool lifecycle and bounds retained rows", () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: "tool-prepared",
      callId: "call-1",
      name: "search",
      input: "query: status",
    });
    expect(state.tools[0]).toMatchObject({
      status: "pending",
      input: "query: status",
    });
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "call-1",
      name: "search",
    });
    state = reducePresentation(state, {
      type: "tool-progress",
      callId: "call-1",
      message: "2 files",
      current: 2,
      total: 4,
    });
    expect(state.tools[0]).toMatchObject({
      status: "running",
      progress: { message: "2 files", current: 2, total: 4 },
    });
    state = reducePresentation(state, {
      type: "tool-result",
      callId: "call-1",
      name: "search",
      result: "done",
    });
    expect(state.tools[0]).toMatchObject({ status: "success", result: "done" });

    state = reducePresentation(state, {
      type: "tool-prepared",
      callId: "call-2",
      name: "write",
    });
    state = reducePresentation(state, {
      type: "tool-blocked",
      callId: "call-2",
      name: "write",
      message: "approval required",
    });
    state = reducePresentation(state, {
      type: "tool-ended",
      callId: "call-2",
      name: "write",
      error: "approval required",
    });
    state = reducePresentation(state, {
      type: "tool-prepared",
      callId: "call-3",
      name: "exec",
    });
    state = reducePresentation(state, {
      type: "tool-failed",
      callId: "call-3",
      name: "exec",
      message: "exit 1",
      category: "tool-execution",
    });
    state = reducePresentation(state, {
      type: "tool-prepared",
      callId: "call-4",
      name: "fetch",
    });
    state = reducePresentation(state, {
      type: "tool-cancelled",
      callId: "call-4",
      name: "fetch",
      message: "turn cancelled",
    });
    expect(state.tools.map(({ status }) => status)).toEqual([
      "success",
      "blocked",
      "error",
      "cancelled",
    ]);

    for (let index = 0; index < MAX_PRESENTATION_TOOLS + 5; index += 1) {
      state = reducePresentation(state, {
        type: "tool-prepared",
        callId: `bounded-${index}`,
        name: "noop",
      });
    }
    expect(state.tools).toHaveLength(MAX_PRESENTATION_TOOLS);
    expect(state.tools[0]?.callId).toBe("bounded-5");
  });

  it("formats bounded structured renderer sections and exposes interaction readiness", async () => {
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy: () => undefined,
        render: () => undefined,
      }),
    });
    await terminal.start();
    const handler = vi.fn(async () => ({
      status: "accepted" as const,
      value: true,
    }));
    const ui = createOpenTuiUiPort(terminal, handler);
    terminal.accept({ type: "user-message", text: "hello" });
    terminal.accept({
      type: "tool-prepared",
      callId: "call-1",
      name: "search",
    });

    const sections = formatPresentationSections(terminal.snapshot());
    expect(sections).toEqual(
      expect.objectContaining({
        header: expect.stringContaining("ready"),
        messages: expect.stringContaining("You\nhello"),
        tools: expect.stringContaining("search · pending"),
      }),
    );
    expect(
      Object.values(sections).every((section) => section.length <= 32_000),
    ).toBe(true);
    expect(terminal.snapshot().interactionHandler).toBe("ready");
    await expect(
      ui.interact(
        { type: "confirm", message: "continue?" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "accepted", value: true });
    await terminal.stop();
  });

  it("renders and answers select, text, confirm, validation, cancellation, and timeout through line input", async () => {
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy: () => undefined,
        render: () => undefined,
      }),
    });
    await terminal.start();

    const selected = terminal.interact!(
      { type: "select", message: "Pick one", options: ["alpha", "beta"] },
      new AbortController().signal,
    );
    expect(formatPresentationSections(terminal.snapshot()).sidebar).toContain(
      "Pick one\n1. alpha\n2. beta",
    );
    expect(terminal.acceptInput!("3")).toBe(true);
    expect(terminal.snapshot().interaction).toMatchObject({
      status: "validation",
      validation: "Choose 1-2 or enter an exact option.",
    });
    expect(terminal.acceptInput!("2")).toBe(true);
    await expect(selected).resolves.toEqual({
      status: "accepted",
      value: "beta",
    });

    const text = terminal.interact!(
      { type: "input", message: "Name?" },
      new AbortController().signal,
    );
    expect(terminal.acceptInput!("octocode")).toBe(true);
    await expect(text).resolves.toEqual({
      status: "accepted",
      value: "octocode",
    });

    const confirmed = terminal.interact!(
      { type: "confirm", message: "Continue?" },
      new AbortController().signal,
    );
    expect(terminal.acceptInput!("yes")).toBe(true);
    await expect(confirmed).resolves.toEqual({
      status: "accepted",
      value: true,
    });

    const discussed = terminal.interact!(
      {
        type: "input",
        message: "Architecture?",
        workflow: {
          workflowId: "ask-1",
          questionId: "architecture",
          index: 1,
          total: 3,
          title: "Design",
          instructions: "Clarify uncertainty first.",
          allowDiscuss: true,
        },
      },
      new AbortController().signal,
    );
    expect(terminal.snapshot().interaction?.request.workflow).toMatchObject({
      questionId: "architecture",
      index: 1,
      total: 3,
    });
    expect(terminal.acceptInput!("/discuss")).toBe(true);
    await expect(discussed).resolves.toEqual({ status: "discuss" });
    expect(terminal.snapshot().interaction).toMatchObject({
      status: "discuss",
    });

    const cancelled = terminal.interact!(
      { type: "input", message: "Cancel me" },
      new AbortController().signal,
    );
    expect(terminal.acceptInput!("/cancel")).toBe(true);
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    expect(terminal.snapshot().interaction).toMatchObject({
      status: "cancelled",
    });

    const timeoutController = new AbortController();
    const timedOut = terminal.interact!(
      { type: "confirm", message: "Too late" },
      timeoutController.signal,
    );
    timeoutController.abort("interaction timeout");
    await expect(timedOut).resolves.toEqual({ status: "timeout" });
    expect(terminal.snapshot().interaction).toMatchObject({
      status: "timeout",
    });
    expect(terminal.acceptInput!("orphan")).toBe(false);
    await terminal.stop();
  });

  it("queues renderer input and cancels a modal before publishing Ctrl-C", async () => {
    let nativeEvents: OpenTuiRendererEvents | undefined;
    const terminal = createOpenTuiTerminal({
      inputOwnership: "renderer",
      createRenderer: async (events) => {
        nativeEvents = events;
        return { destroy: () => undefined, render: () => undefined };
      },
    });
    const received: unknown[] = [];
    terminal.subscribeInput?.((event) => {
      received.push(event);
    });
    await terminal.start();

    nativeEvents!.submitInput({ schemaVersion: 1, parts: [{ type: "text", text: "queued" }] });
    expect(received).toEqual([]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(received).toEqual([{
      type: "input",
      input: { schemaVersion: 1, parts: [{ type: "text", text: "queued" }] },
    }]);

    const interaction = terminal.interact!(
      { type: "confirm", message: "Proceed?" },
      new AbortController().signal,
    );
    nativeEvents!.interrupt();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await expect(interaction).resolves.toEqual({ status: "cancelled" });
    expect(received).toEqual([{
      type: "input",
      input: { schemaVersion: 1, parts: [{ type: "text", text: "queued" }] },
    }]);

    nativeEvents!.interrupt();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(received.at(-1)).toEqual({ type: "interrupt" });
    await terminal.stop();
  });
});
