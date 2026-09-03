import { describe, expect, it } from "vitest";

import {
  WorkerProgressWidget,
  type WorkerProgressSnapshot,
} from "../src/terminal/opentui/widgets/worker-progress.js";

function worker(
  overrides: Partial<WorkerProgressSnapshot> = {},
): WorkerProgressSnapshot {
  return {
    authority: "runtime",
    workerId: "architecture-audit",
    agentType: "researcher",
    state: "running",
    startedAtMs: 1_000,
    updatedAtMs: 43_000,
    ...overrides,
  };
}

describe("WorkerProgressWidget", () => {
  it("shows optional agent type, explicit state, elapsed time, and semantic tone", () => {
    const widget = new WorkerProgressWidget("worker-1", worker());
    const rendered = widget.render();
    expect(rendered.kind).toBe("worker.progress");
    expect(rendered.regions).toEqual([
      expect.objectContaining({
        id: "summary",
        tone: "info",
        text: "● researcher · RUNNING · 42s",
      }),
    ]);
    expect(widget.toPlainText()).not.toContain("architecture-audit");
  });

  it("emits each sanitized lifecycle transition once for append-only accessible output", () => {
    const widget = new WorkerProgressWidget("worker-announcements", worker());
    expect(widget.takeAnnouncements()).toEqual(["● researcher · RUNNING · 42s"]);
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(worker({ state: "aborted", updatedAtMs: 44_000 }));
    expect(widget.takeAnnouncements()).toEqual(["! researcher · ABORTED · 43s"]);
    expect(widget.takeAnnouncements()).toEqual([]);
    expect(JSON.stringify(widget.takeAnnouncements())).not.toContain("architecture-audit");
  });

  it("makes the subagent list position explicit without exposing identity", () => {
    const widget = new WorkerProgressWidget(
      "worker-list",
      worker({ listPosition: 2, listTotal: 3 }),
    );

    expect(widget.render().regions[0]?.text).toBe(
      "● Subagent 2/3 · researcher · RUNNING · 42s",
    );
    expect(widget.toPlainText()).not.toContain("architecture-audit");
  });

  it.each([
    ["queued", "info", "○ QUEUED"],
    ["succeeded", "success", "✓ SUCCEEDED"],
    ["failed", "error", "× FAILED"],
    ["aborted", "warning", "! ABORTED"],
    ["killed", "error", "× KILLED"],
  ] as const)("renders %s without relying on color", (state, tone, text) => {
    const widget = new WorkerProgressWidget(
      `worker-${state}`,
      worker({ state }),
    );
    expect(widget.render().regions[0]).toMatchObject({ tone });
    expect(widget.render().regions[0]?.text).toContain(text.slice(0, 1));
    expect(widget.render().regions[0]?.text).toContain(state.toUpperCase());
  });

  it("keeps credential-like worker identity private and rejects invalid timestamps", () => {
    const widget = new WorkerProgressWidget(
      "worker-redacted",
      worker({
        workerId: "api_key=secret-value",
      }),
    );
    expect(widget.toPlainText()).not.toContain("secret-value");
    expect(widget.toPlainText()).not.toContain("[REDACTED]");
    expect(
      () =>
        new WorkerProgressWidget("worker-invalid", worker({ updatedAtMs: 0 })),
    ).toThrow(/timestamps/i);
  });

  it("does not project plan/task attribution or aggregate capacity", () => {
    const widget = new WorkerProgressWidget(
      "worker-queued",
      worker({
        state: "queued",
        taskLabel: "Research",
        planStepId: "step-2",
        active: 1,
        queued: 2,
        maxActive: 4,
      }),
    );

    expect(widget.toPlainText()).not.toContain("Research");
    expect(widget.toPlainText()).not.toContain("step-2");
    expect(widget.toPlainText()).not.toContain("Active 1/4");
    expect(widget.toPlainText()).not.toContain("Queued 2");
    expect(JSON.stringify(widget.render())).not.toMatch(
      /prompt|thinking|handback|reason/i,
    );
  });
});
