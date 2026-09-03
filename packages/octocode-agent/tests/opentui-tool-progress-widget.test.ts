import { describe, expect, it } from "vitest";

import {
  ToolProgressWidget,
  type ToolProgressSnapshot,
} from "../src/terminal/opentui/widgets/tool-progress.js";

function running(
  overrides: Partial<ToolProgressSnapshot> = {},
): ToolProgressSnapshot {
  return {
    authority: "runtime",
    callId: "call-42",
    toolName: "localSearch",
    status: "running",
    inputSummary: "query=widget api_key=super-secret password: hunter2",
    reducedMotion: true,
    ...overrides,
  };
}

describe("ToolProgressWidget", () => {
  it("renders an explicit, color-independent running state and redacts bounded input", () => {
    const widget = new ToolProgressWidget("tool-progress-1", running());
    widget.mount();
    widget.activate();

    const rendered = widget.render();
    const text = rendered.regions.map((region) => region.text).join("\n");

    expect(text).toContain("RUNNING");
    expect(text).toContain("localSearch");
    expect(text).not.toContain("call-42");
    expect(text).toContain("in progress");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("hunter2");
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);

    widget.focus();
    widget.handleInput({ type: "key", key: "Enter" });
    expect(
      widget
        .render()
        .regions.map((region) => region.text)
        .join("\n"),
    ).not.toContain("call call-42");
    expect(widget.toPlainText({ expanded: true })).toContain("(call-42)");
  });

  it.each([
    ["pending", "○ [PENDING]"],
    ["running", "… [RUNNING]"],
    ["success", "✓ [SUCCESS]"],
    ["blocked", "! [BLOCKED]"],
    ["cancelled", "× [CANCELLED]"],
    ["error", "✗ [ERROR]"],
  ] as const)(
    "renders the %s state with a glyph and explicit word",
    (status, expected) => {
      const widget = new ToolProgressWidget(
        `tool-${status}`,
        running({ status }),
      );
      expect(widget.toPlainText()).toContain(expected);
    },
  );

  it("shows current and total only when both are truthful", () => {
    const known = new ToolProgressWidget(
      "tool-known",
      running({ current: 3, total: 8 }),
    );
    expect(known.toPlainText()).toContain("3/8");

    const unknown = new ToolProgressWidget(
      "tool-unknown",
      running({ current: 3 }),
    );
    expect(unknown.toPlainText()).toContain("in progress");
    expect(unknown.toPlainText()).not.toContain("3/");

    expect(
      () =>
        new ToolProgressWidget(
          "tool-invalid",
          running({ current: 9, total: 8 }),
        ),
    ).toThrow(/truthful progress/i);
  });

  it("renders and throttles runtime progress messages", () => {
    const widget = new ToolProgressWidget(
      "tool-message",
      running({ message: "Searching workspace" }),
      0,
    );
    expect(widget.toPlainText()).toContain("Searching workspace");
    widget.takeAnnouncements();
    widget.update(running({ message: "Reading matches" }), 2_000);
    expect(widget.takeAnnouncements()).toEqual([
      "Tool localSearch: Reading matches (call-42).",
    ]);
  });

  it("renders classified terminal results and errors without raw dumps", () => {
    const success = new ToolProgressWidget(
      "tool-success",
      running({
        status: "success",
        outcome: {
          authority: "runtime",
          classification: "result",
          summary: "Found 12 matching files",
        },
      }),
    );
    expect(success.toPlainText()).toContain("result: Found 12 matching files");

    const failed = new ToolProgressWidget(
      "tool-failed",
      running({
        status: "error",
        outcome: {
          authority: "runtime",
          classification: "permission",
          summary: "token=secret-token denied",
        },
      }),
    );
    expect(failed.toPlainText()).toContain("permission:");
    expect(failed.toPlainText()).toContain("[REDACTED]");
    expect(failed.toPlainText()).not.toContain("secret-token");
  });

  it("strips ANSI, OSC, and remaining terminal control characters from summaries", () => {
    const widget = new ToolProgressWidget(
      "tool-terminal-safe",
      running({
        inputSummary:
          "\u001b[31mred\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 ok\u0000bad",
        outcome: {
          authority: "runtime",
          classification: "result",
          summary: "\u001b]0;forged title\u0007safe\u001b[2Jresult\u009b31m",
        },
      }),
    );

    const text = widget.toPlainText({ expanded: true });
    expect(text).toContain("red");
    expect(text).toContain("link");
    expect(text).toContain("safe");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("forged title");
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  });

  it("announces start once, throttles and deduplicates material progress, and terminates once", () => {
    const widget = new ToolProgressWidget(
      "tool-announcements",
      running({ current: 0, total: 100 }),
      0,
    );

    expect(widget.takeAnnouncements()).toEqual([
      "Tool localSearch started (call-42).",
    ]);
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(running({ current: 1, total: 100 }), 1_000);
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(running({ current: 10, total: 100 }), 1_100);
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(running({ current: 10, total: 100 }), 2_000);
    expect(widget.takeAnnouncements()).toEqual([
      "Tool localSearch progress: 10/100 (call-42).",
    ]);

    widget.update(
      running({
        status: "success",
        current: 100,
        total: 100,
        outcome: {
          authority: "runtime",
          classification: "result",
          summary: "done",
        },
      }),
      3_000,
    );
    expect(widget.takeAnnouncements()).toEqual([
      "Tool localSearch finished: success (call-42).",
    ]);

    widget.update(
      running({
        status: "error",
        outcome: {
          authority: "runtime",
          classification: "system",
          summary: "late",
        },
      }),
      4_000,
    );
    expect(widget.takeAnnouncements()).toEqual([]);
    expect(widget.toPlainText()).toContain("[SUCCESS]");
  });

  it("bounds collapsed and expanded alternate plain text and supplies complete agent instructions", () => {
    const widget = new ToolProgressWidget(
      "tool-bounds",
      running({
        inputSummary: `query=${"x".repeat(2_000)}`,
        outcome: {
          authority: "runtime",
          classification: "result",
          summary: "y".repeat(4_000),
        },
      }),
    );

    const collapsed = widget.toPlainText();
    const expanded = widget.toPlainText({ expanded: true });
    expect(collapsed.length).toBeLessThanOrEqual(480);
    expect(expanded.length).toBeLessThanOrEqual(1_200);
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(collapsed).toContain("…");
    expect(widget.instructions).toMatchObject({
      purpose: expect.stringContaining("tool"),
      inputs: expect.arrayContaining([
        expect.stringMatching(/runtime-authoritative/i),
      ]),
      stateAndOutput: expect.arrayContaining([
        expect.stringMatching(/never fabricate.*percent/i),
        expect.stringMatching(/terminal.*once/i),
      ]),
      accessibility: expect.arrayContaining([
        expect.stringMatching(/color/i),
        expect.stringMatching(/reduced motion/i),
      ]),
      recovery: expect.arrayContaining([
        expect.stringMatching(/secret|raw tool/i),
      ]),
    });
  });

  it("is keyboard focusable and toggles bounded details with Enter", () => {
    const widget = new ToolProgressWidget(
      "tool-expandable",
      running({
        inputSummary: `query=${"x".repeat(240)}`,
        outcome: {
          authority: "runtime",
          classification: "result",
          summary: "y".repeat(480),
        },
      }),
    );
    widget.mount();
    widget.activate();
    widget.focus();

    const collapsed = widget
      .render()
      .regions.map(({ text }) => text)
      .join("\n");
    expect(collapsed).toContain("details collapsed");
    expect(widget.handleInput({ type: "key", key: "enter" })).toMatchObject({
      status: "handled",
    });
    const expanded = widget
      .render()
      .regions.map(({ text }) => text)
      .join("\n");
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(expanded).toContain("details expanded");
  });

  it("rejects identity drift for a stable call id and tool name", () => {
    const widget = new ToolProgressWidget("tool-stable", running());
    expect(() =>
      widget.update(running({ callId: "other-call" }), 1_000),
    ).toThrow(/call id/i);
    expect(() =>
      widget.update(running({ toolName: "otherTool" }), 1_000),
    ).toThrow(/tool name/i);
  });

  it("rejects runtime-invalid status and outcome classification values", () => {
    expect(
      () =>
        new ToolProgressWidget(
          "tool-bad-status",
          running({
            status: "invented" as ToolProgressSnapshot["status"],
          }),
        ),
    ).toThrow(/status/i);
    expect(
      () =>
        new ToolProgressWidget(
          "tool-bad-classification",
          running({
            outcome: {
              authority: "runtime",
              classification: "invented" as NonNullable<
                ToolProgressSnapshot["outcome"]
              >["classification"],
              summary: "bad",
            },
          }),
        ),
    ).toThrow(/classification/i);
  });

  it("requires runtime authority for status and outcome classification", () => {
    expect(
      () =>
        new ToolProgressWidget(
          "tool-model-status",
          running({
            authority: "model" as ToolProgressSnapshot["authority"],
          }),
        ),
    ).toThrow(/runtime authority/i);
    expect(
      () =>
        new ToolProgressWidget(
          "tool-model-outcome",
          running({
            status: "success",
            outcome: {
              authority: "model" as NonNullable<
                ToolProgressSnapshot["outcome"]
              >["authority"],
              classification: "result",
              summary: "forged",
            },
          }),
        ),
    ).toThrow(/runtime authority/i);
  });

  it("rejects rather than truncating or normalizing unsafe stable identities", () => {
    expect(
      () =>
        new ToolProgressWidget(
          "tool-unsafe-call",
          running({
            callId: "call\u202e-42",
          }),
        ),
    ).toThrow(/stable id|bidi|call id/i);
    expect(
      () =>
        new ToolProgressWidget(
          "tool-unsafe-name",
          running({
            toolName: "\u001b[31mlocalSearch",
          }),
        ),
    ).toThrow(/stable id|terminal|tool name/i);
    expect(
      () =>
        new ToolProgressWidget(
          "tool-long-call",
          running({
            callId: `c${"x".repeat(200)}`,
          }),
        ),
    ).toThrow(/at most|call id/i);
  });

  it.each(["success", "blocked", "cancelled", "error"] as const)(
    "renders an explicit %s terminal progress state when totals are absent",
    (status) => {
      const widget = new ToolProgressWidget(
        `tool-terminal-${status}`,
        running({ status }),
      );
      expect(widget.toPlainText()).toContain(`terminal state: ${status}`);
      expect(widget.toPlainText()).not.toContain("in progress");
    },
  );
});
