import { describe, expect, it } from "vitest";

import {
  WorkerProgressWidget,
  type WorkerProgressSnapshot,
} from "../src/terminal/opentui/widgets/worker-progress.js";

const PRIVATE_WORKER_ID = "worker-private-identity";
const PRIVATE_TASK_LABEL = "Inspect the private delegated prompt";
const PRIVATE_PLAN_STEP = "secret-plan-step";

function privateSnapshot(
  overrides: Partial<WorkerProgressSnapshot> = {},
): WorkerProgressSnapshot {
  return {
    authority: "runtime",
    workerId: PRIVATE_WORKER_ID,
    agentType: "researcher",
    state: "running",
    active: 3,
    queued: 2,
    maxActive: 4,
    planStepId: PRIVATE_PLAN_STEP,
    taskLabel: PRIVATE_TASK_LABEL,
    startedAtMs: 1_000,
    updatedAtMs: 43_000,
    ...overrides,
  };
}

describe("WorkerProgressWidget privacy boundary", () => {
  it("keeps stable identity, assignment, and capacity out of visual and alternate output", () => {
    const widget = new WorkerProgressWidget("worker-private", privateSnapshot());
    const visual = widget.render().regions.map(({ text }) => text).join("\n");
    const alternate = widget.toPlainText();
    const publicOutput = `${visual}\n${alternate}`;

    expect(widget.render().regions.map(({ id }) => id)).toEqual(["summary"]);
    expect(publicOutput).toContain("researcher");
    expect(publicOutput).toContain("RUNNING");
    expect(publicOutput).toContain("42s");
    expect(publicOutput).not.toContain(PRIVATE_WORKER_ID);
    expect(publicOutput).not.toContain(PRIVATE_TASK_LABEL);
    expect(publicOutput).not.toContain(PRIVATE_PLAN_STEP);
    expect(publicOutput).not.toMatch(/Active|Queued|3\/4/u);
  });

  it("retains stable worker identity only as an update invariant", () => {
    const widget = new WorkerProgressWidget("worker-stable", privateSnapshot());

    expect(() => widget.update(privateSnapshot({ updatedAtMs: 44_000 }))).not.toThrow();
    expect(() => widget.update(privateSnapshot({
      workerId: "different-private-worker",
      updatedAtMs: 45_000,
    }))).toThrow(/worker id cannot change/i);
  });
});
