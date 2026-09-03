import { describe, expect, it, vi } from "vitest";

import { createOpenTuiTerminal } from "../src/terminal/opentui/create-terminal.js";
import {
  createInitialPresentationState,
  formatPresentationFrame,
  reducePresentation,
} from "../src/terminal/opentui/presentation.js";

describe("OpenTUI compound terminal acceptance matrix", () => {
  it("keeps tool progress and terminal settlement monotonic while allowing a distinct retry", () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: "tool-started",
      callId: "attempt-1",
      name: "indexed-search",
    });
    state = reducePresentation(state, {
      type: "tool-progress",
      callId: "attempt-1",
      name: "indexed-search",
      message: "seven files",
      current: 7,
      total: 10,
    });
    const afterNewestProgress = state;

    state = reducePresentation(state, {
      type: "tool-progress",
      callId: "attempt-1",
      name: "indexed-search",
      message: "reordered three files",
      current: 3,
      total: 10,
    });
    expect(state).toBe(afterNewestProgress);

    state = reducePresentation(state, {
      type: "tool-ended",
      callId: "attempt-1",
      name: "indexed-search",
      result: "ten files",
    });
    const settled = state;
    for (const lateEvent of [
      {
        type: "tool-progress" as const,
        callId: "attempt-1",
        name: "indexed-search",
        message: "late nine files",
        current: 9,
        total: 10,
      },
      {
        type: "tool-started" as const,
        callId: "attempt-1",
        name: "indexed-search",
      },
      {
        type: "tool-cancelled" as const,
        callId: "attempt-1",
        name: "indexed-search",
        message: "late cancellation",
      },
    ]) {
      state = reducePresentation(state, lateEvent);
      expect(state).toBe(settled);
    }
    expect(state.tools).toEqual([
      expect.objectContaining({
        callId: "attempt-1",
        status: "success",
        result: "ten files",
        progress: { message: "seven files", current: 7, total: 10 },
      }),
    ]);

    state = reducePresentation(state, {
      type: "tool-started",
      callId: "attempt-2",
      name: "indexed-search",
    });
    expect(state.tools).toEqual([
      expect.objectContaining({ callId: "attempt-1", status: "success" }),
      expect.objectContaining({ callId: "attempt-2", status: "running" }),
    ]);
  });

  it("coalesces interleaved notification bursts without changing first-transition order", () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: "runtime-widgets-changed",
      snapshots: {
        statusNotifications: [{
          authority: "runtime",
          slot: "permission",
          id: "approval-required",
          message: "Approval required for safe action",
          lifecycle: "active",
        }],
      },
    });
    const burst = [
      { type: "notification" as const, severity: "info" as const, key: "provider", message: "Provider request started" },
      { type: "notification" as const, severity: "info" as const, key: "discovery", message: "MCP discovery started" },
      { type: "notification" as const, severity: "info" as const, key: "provider", message: "Provider request 25%" },
      { type: "notification" as const, severity: "info" as const, key: "discovery", message: "MCP discovery 50%" },
      { type: "notification" as const, severity: "success" as const, key: "provider", message: "Provider request completed" },
      { type: "notification" as const, severity: "warning" as const, key: "discovery", message: "MCP discovery cancelled" },
    ];
    for (let iteration = 0; iteration < 20; iteration += 1) {
      for (const event of burst) {
        state = reducePresentation(state, event);
        const keys = state.notifications.map(({ key }) => key);
        expect(keys).toEqual(
          keys.includes("discovery") ? ["provider", "discovery"] : ["provider"],
        );
      }
    }

    expect(state.notifications).toEqual([
      { key: "provider", severity: "success", message: "Provider request completed" },
      { key: "discovery", severity: "warning", message: "MCP discovery cancelled" },
    ]);
    expect(formatPresentationFrame(state)).toContain("[success] Provider request completed");
    expect(formatPresentationFrame(state)).toContain("[warning] MCP discovery cancelled");
    expect(state.runtimeWidgets?.statusNotifications).toEqual([
      expect.objectContaining({
        id: "approval-required",
        lifecycle: "active",
        message: "Approval required for safe action",
      }),
    ]);

    state = reducePresentation(state, {
      type: "tool-failed",
      callId: "unrelated-tool",
      name: "bash",
      message: "safe public failure",
    });
    expect(state.runtimeWidgets?.statusNotifications?.[0]?.lifecycle).toBe("active");

    state = reducePresentation(state, { type: "session-replaced" });
    expect(state.notifications).toEqual([]);
  });

  it("destroys exactly once for renderer failure, interrupted stream, and concurrent shutdown", async () => {
    let releaseDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    const destroy = vi.fn(async () => destroyGate);
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy,
        render: () => {
          throw new Error("injected renderer exception");
        },
      }),
    });
    const failure = new Promise<unknown>((resolve) => terminal.subscribeFailure?.(resolve));

    await terminal.start();
    terminal.accept({
      type: "message-started",
      messageId: "interrupted",
      role: "assistant",
    });
    terminal.accept({
      type: "message-delta",
      messageId: "interrupted",
      text: "partial stream",
    });
    await expect(failure).resolves.toEqual(
      expect.objectContaining({ message: "injected renderer exception" }),
    );

    const first = terminal.stop();
    const second = terminal.stop();
    const third = terminal.stop();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(destroy).toHaveBeenCalledOnce();
    releaseDestroy();
    await Promise.all([first, second, third]);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
