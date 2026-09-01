import {
  ScrollBoxRenderable,
  SelectRenderable,
  TabSelectRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { createTestRenderer, KeyCodes } from "@opentui/core/testing";
import { describe, expect, it } from "vitest";

import {
  createInitialPresentationState,
  type PresentationState,
} from "../src/terminal/opentui/presentation.js";
import { createOpenTuiRendererFacade } from "../src/terminal/opentui/renderer.js";
import { terminalDisplayWidth } from "../src/terminal/opentui/widgets/layout.js";

const FORBIDDEN_REASONING = "private chain of thought: choose unsafe shortcut";
const FORBIDDEN_WORKER_ASSIGNMENT = "private delegated worker prompt";

const VIEWPORTS = [
  { width: 120, height: 40 },
  { width: 80, height: 24 },
  { width: 60, height: 20 },
  { width: 40, height: 18 },
] as const;

const hasNativeFfi =
  process.execArgv.includes("--experimental-ffi") ||
  process.env.NODE_OPTIONS?.split(/\s+/u).includes("--experimental-ffi") === true;
const describeNativeFfi = hasNativeFfi ? describe : describe.skip;

function highPressureState(): PresentationState {
  return {
    ...createInitialPresentationState(),
    ready: true,
    working: "active",
    chrome: {
      authority: "runtime",
      title: "Held-out terminal UX",
      sessionId: "session-held-out",
      modelId: "model-held-out",
      trust: "trusted",
      connection: "connected",
    },
    activeTurnId: "turn-held-out",
    turns: [{ id: "turn-held-out", status: "active" }],
    messages: [
      {
        id: "assistant-held-out",
        role: "assistant",
        turnId: "turn-held-out",
        status: "streaming",
        segments: [
          { kind: "thinking", text: FORBIDDEN_REASONING },
          { kind: "text", text: "Public progress remains safe." },
        ],
      },
    ],
    tools: [
      {
        callId: "tool-running",
        name: "filesystem",
        turnId: "turn-held-out",
        status: "running",
        input: "Read bounded source",
        progress: { message: "Indexing", current: 4, total: 10 },
      },
      {
        callId: "tool-blocked",
        name: "network",
        turnId: "turn-held-out",
        status: "blocked",
        error: { message: "Approval required", category: "policy" },
      },
      {
        callId: "tool-error",
        name: "build",
        turnId: "turn-held-out",
        status: "error",
        error: { message: "Focused check failed", category: "test" },
      },
    ],
    workers: [
      {
        workerId: "worker-held-out-private-id",
        agentType: "researcher",
        state: "running",
        active: 1,
        queued: 1,
        maxActive: 4,
        planStepId: "private-step",
        taskLabel: FORBIDDEN_WORKER_ASSIGNMENT,
        startedAtMs: 1_000,
        updatedAtMs: 45_000,
      },
    ],
    statuses: { "context.compaction": "running" },
    interactionHandler: "ready",
    interaction: {
      generation: 7,
      request: { type: "confirm", message: "Approve protected action?" },
      status: "pending",
    },
    runtimeWidgets: {
      plan: {
        authority: "runtime",
        planId: "plan-held-out",
        scope: { sessionId: "session-held-out", workspace: "/workspace" },
        revision: 4,
        phase: "active",
        steps: [
          { id: "done", text: "Map behavior", status: "done" },
          { id: "one", text: "Implement one", status: "doing", dependsOn: ["done"] },
          { id: "two", text: "Implement two", status: "doing", dependsOn: ["done"] },
          { id: "three", text: "Implement three", status: "doing", dependsOn: ["done"] },
          { id: "four", text: "Implement four", status: "doing", dependsOn: ["done"] },
          { id: "verify", text: "Verify behavior", status: "todo", dependsOn: ["one", "two", "three", "four"] },
        ],
      },
      statusNotifications: [
        {
          authority: "runtime",
          slot: "permission",
          id: "approval",
          message: "Approval required for protected action",
          lifecycle: "active",
        },
        {
          authority: "runtime",
          slot: "system",
          id: "context-warning",
          message: "Context usage is critical",
          lifecycle: "warning",
        },
      ],
    },
  };
}

describeNativeFfi("held-out OpenTUI viewport acceptance matrix", () => {
  it.each(VIEWPORTS)(
    "keeps the action, composer recovery, safe status, and activity reachable at $width x $height",
    async ({ width, height }) => {
      const setup = await createTestRenderer({ width, height, footerHeight: 0 });
      const state = highPressureState();
      const facade = createOpenTuiRendererFacade(setup.renderer, {
        initialState: state,
        alternateOutput: true,
        nowMs: () => 45_000,
      });
      facade.render(state);
      await setup.flush();

      const composer = setup.renderer.root.findDescendantById(
        "octocode-agent-composer",
      ) as TextareaRenderable;
      const action = setup.renderer.root.findDescendantById(
        "interaction-7-confirm",
      ) as SelectRenderable;
      const rail = setup.renderer.root.findDescendantById(
        "octocode-agent-rail",
      ) as ScrollBoxRenderable;
      const tabs = setup.renderer.root.findDescendantById(
        "octocode-agent-rail-tabs",
      ) as TabSelectRenderable;
      const initialFrame = setup.captureCharFrame();
      const alternate = facade.alternateOutput?.() ?? "";

      expect(composer).toBeInstanceOf(TextareaRenderable);
      expect(composer.visible).toBe(false);
      expect(action).toBeInstanceOf(SelectRenderable);
      expect(action.y).toBeGreaterThanOrEqual(0);
      expect(action.y + action.height).toBeLessThanOrEqual(height);
      expect(rail.visible).toBe(width >= 72 || height >= 24);
      expect(initialFrame).toContain("Approve protected action?");
      expect(initialFrame).not.toContain(FORBIDDEN_REASONING);
      expect(alternate).not.toContain(FORBIDDEN_REASONING);
      expect(alternate).not.toContain(FORBIDDEN_WORKER_ASSIGNMENT);
      expect(alternate).toContain("[thinking]");
      expect(alternate).toContain("Public progress remains safe.");
      expect(alternate).toContain("filesystem");
      expect(alternate).toContain("network");
      expect(alternate).toContain("build");
      expect(alternate).toContain("researcher");
      expect(alternate).toContain("plan-held-out");
      expect(alternate).toContain("Approve protected action?");
      expect(alternate).toContain("context.compaction: running");
      expect(alternate).toContain("Context usage is critical");
      const overflowingInitialLines = initialFrame.split("\n")
        .map((line) => ({ line, width: terminalDisplayWidth(line) }))
        .filter((line) => line.width > width);
      expect(overflowingInitialLines).toEqual([]);

      const settled: PresentationState = {
        ...state,
        interaction: {
          ...state.interaction!,
          status: "accepted",
          value: true,
        },
      };
      facade.render(settled);
      await setup.flush();

      expect(composer.visible).toBe(true);
      expect(composer.y).toBeGreaterThanOrEqual(0);
      expect(composer.y + composer.height).toBeLessThanOrEqual(height);
      setup.mockInput.pressKey(KeyCodes.TAB);
      await setup.flush();
      expect(rail.visible).toBe(true);
      expect(tabs.focused).toBe(true);

      const recoveredFrame = setup.captureCharFrame();
      const overflowingRecoveredLines = recoveredFrame.split("\n")
        .map((line) => ({ line, width: terminalDisplayWidth(line) }))
        .filter((line) => line.width > width);
      expect(overflowingRecoveredLines).toEqual([]);
      expect(recoveredFrame).not.toContain(FORBIDDEN_REASONING);

      await facade.destroy();
      setup.renderer.destroy();
    },
  );
});
