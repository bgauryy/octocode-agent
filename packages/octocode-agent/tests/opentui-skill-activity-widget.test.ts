import { describe, expect, it } from "vitest";

import {
  SkillActivityWidget,
  type SkillActivitySnapshot,
} from "../src/terminal/opentui/widgets/skill-activity.js";

function snapshot(
  overrides: Partial<SkillActivitySnapshot> = {},
): SkillActivitySnapshot {
  return {
    authority: "runtime",
    operationId: "skill-operation-1",
    name: "research",
    sourceScope: "workspace",
    action: "enable",
    state: "running",
    result: "In progress",
    ...overrides,
  };
}

describe("SkillActivityWidget", () => {
  it.each([
    ["discover", "Catalog"],
    ["enable", "research"],
    ["disable", "research"],
    ["refresh", "Catalog"],
    ["install", "research"],
    ["update", "research"],
    ["remove", "research"],
  ] as const)("renders the %s action as a dedicated Skill card", (action, name) => {
    const widget = new SkillActivityWidget("skill-card", snapshot({ action, name }));
    const rendered = widget.render();

    expect(rendered.kind).toBe("skill.activity");
    expect(rendered.regions.map(({ id }) => id)).toEqual([
      "skill",
      "source",
      "action",
      "state",
      "result",
    ]);
    expect(rendered.regions.find(({ id }) => id === "action")?.text).toBe(
      `Action: ${action.slice(0, 1).toUpperCase()}${action.slice(1)}`,
    );
  });

  it.each([
    ["pending", "○ PENDING"],
    ["running", "◐ RUNNING"],
    ["approval-required", "? APPROVAL REQUIRED"],
    ["rejected", "! REJECTED"],
    ["completed", "✓ COMPLETED"],
    ["failed", "✗ FAILED"],
    ["cancelled", "× CANCELLED"],
  ] as const)("renders the %s state textually", (state, marker) => {
    const widget = new SkillActivityWidget("skill-card", snapshot({ state }));
    expect(widget.render().regions.find(({ id }) => id === "state")?.text).toBe(
      `State: ${marker}`,
    );
  });

  it.each([
    "discover",
    "enable",
    "disable",
    "refresh",
    "install",
    "update",
    "remove",
  ] as const)("keeps the %s summary identical and safe for hostile oversized input", (action) => {
    const hostile = `${"👩🏽‍💻".repeat(300)}\n\u001b[31m\u202E token=secret-value sk-1234567890abcdef`;
    const widget = new SkillActivityWidget("skill-card", snapshot({
      operationId: `skill-operation-hostile-${action}`,
      action,
      name: hostile,
      sourceScope: hostile,
      result: `${hostile} /Users/private/skills/research/SKILL.md C:\\private\\skill.md`,
    }));
    const rendered = widget.render();
    const visual = rendered.regions.map(({ text }) => text).join("\n");
    const plain = widget.toPlainText();

    expect(plain).toBe(visual);
    expect(plain).not.toMatch(/[\u001b\u202E\r]/u);
    expect(plain).not.toContain("secret-value");
    expect(plain).not.toContain("sk-1234567890abcdef");
    expect(plain).not.toContain("/Users/private");
    expect(plain).not.toContain("C:\\private");
    expect(plain).not.toContain("👩🏽‍💻".repeat(100));
    expect(plain).toContain("[REDACTED]");
    expect(rendered.regions).toHaveLength(5);
  });

  it("rejects non-enum action and state lanes without rendering attacker text", () => {
    expect(() => new SkillActivityWidget("skill-card", snapshot({
      action: "install\nBearer attacker-secret" as never,
    }))).toThrow("action");
    expect(() => new SkillActivityWidget("skill-card", snapshot({
      state: "failed\nBearer attacker-secret" as never,
    }))).toThrow("state");
  });

  it("allows approval-required to advance after approval", () => {
    const widget = new SkillActivityWidget("skill-card", snapshot({
      state: "approval-required",
      result: "Approval required to continue",
    }));
    widget.update(snapshot({ state: "running", result: "Approved; in progress" }));
    expect(widget.toPlainText()).toContain("RUNNING");
  });

  it.each([
    ["rejected", "Rejected"],
    ["completed", "Enabled"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("preserves the %s terminal outcome against late progress", (state, result) => {
    const widget = new SkillActivityWidget("skill-card", snapshot({ state, result }));
    const terminal = widget.toPlainText();
    widget.update(snapshot({ state: "running", result: "late progress" }));
    expect(widget.toPlainText()).toBe(terminal);
    expect(terminal).toContain(`Result: ${result}`);
  });
});
