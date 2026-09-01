import { describe, expect, it, vi } from "vitest";
import {
  ModelContextOverflowError,
  RuntimeFailure,
  RuntimeKernel,
  sessionId,
  type ModelMessage,
  type ModelRequest,
} from "../src/index.js";

const stablePrompt: ModelMessage = {
  role: "system",
  content: "immutable product policy",
};

describe("runtime context preflight and overflow compaction", () => {
  it("compacts a model-aware over-budget request before provider admission and preserves the stable prefix", async () => {
    const order: string[] = [];
    const requests: ModelRequest[] = [];
    const measurements = [80, 30];
    const compact = vi.fn(async (input: {
      reason: string;
      messages: readonly ModelMessage[];
      stablePrefix: readonly ModelMessage[];
    }) => {
      order.push("compact");
      expect(input.reason).toBe("threshold");
      expect(input.stablePrefix).toEqual([stablePrompt]);
      return {
        summary: "short",
        messages: [
          stablePrompt,
          { role: "system" as const, content: "Summary: short" },
          { role: "user" as const, content: "current request" },
        ],
      };
    });
    const kernel = new RuntimeKernel({
      sessionId: sessionId("model-aware-preflight"),
      initialMessages: [
        stablePrompt,
        { role: "user", content: "large prior history" },
      ],
      stablePrefixMessageCount: 1,
      modelLimits: { context: 100, output: 20 },
      compactionSafetyMarginTokens: 10,
      compactionSoftLimitRatio: 1,
      contextTokenMeter: {
        measure: async () => measurements.shift()!,
      },
      compaction: { compact },
      model: {
        run: async (request) => {
          order.push("model");
          requests.push(request);
          return {
            stop: "complete",
            usage: { inputTokens: 30, outputTokens: 1 },
          };
        },
      },
    });

    await kernel.submit("current request");

    expect(order).toEqual(["compact", "model"]);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([
      stablePrompt,
      { role: "system", content: "Summary: short" },
      { role: "user", content: "current request" },
    ]);
    expect(requests[0]?.cache).toEqual({
      stablePrefixMessageCount: 1,
    });
  });

  it("admits a soft-over-budget request when compaction cannot shrink immutable request overhead", async () => {
    const compact = vi.fn(async ({ messages }: { messages: readonly ModelMessage[] }) => ({
      summary: "same-size",
      messages,
    }));
    const run = vi.fn(async () => ({
      stop: "complete" as const,
      usage: { inputTokens: 80, outputTokens: 1 },
    }));
    const kernel = new RuntimeKernel({
      sessionId: sessionId("soft-limit-no-progress"),
      initialMessages: [stablePrompt],
      stablePrefixMessageCount: 1,
      modelLimits: { context: 100, output: 10 },
      compactionSafetyMarginTokens: 10,
      compactionSoftLimitRatio: 0.9,
      contextTokenMeter: { measure: async () => 75 },
      compaction: { compact },
      model: { run },
    });

    await kernel.submit("current request");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects an unchanged request at the hard input limit before provider admission", async () => {
    const compact = vi.fn(async ({ messages }: { messages: readonly ModelMessage[] }) => ({
      summary: "same-size",
      messages,
    }));
    const run = vi.fn(async () => ({
      stop: "complete" as const,
      usage: { inputTokens: 80, outputTokens: 1 },
    }));
    const kernel = new RuntimeKernel({
      sessionId: sessionId("hard-limit-no-progress"),
      initialMessages: [stablePrompt],
      stablePrefixMessageCount: 1,
      modelLimits: { context: 100, output: 10 },
      compactionSafetyMarginTokens: 10,
      compactionSoftLimitRatio: 0.9,
      contextTokenMeter: { measure: async () => 80 },
      compaction: { compact },
      model: { run },
    });

    await expect(kernel.submit("current request")).rejects.toMatchObject({
      category: "model",
      message: "Compacted context still exceeds the model input budget",
    });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a compaction result that mutates the declared stable prefix", async () => {
    const requests: ModelRequest[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId("stable-prefix-guard"),
      initialMessages: [stablePrompt, { role: "user", content: "history" }],
      stablePrefixMessageCount: 1,
      compaction: {
        compact: async () => ({
          summary: "invalid",
          messages: [
            { role: "system", content: "mutated product policy" },
            { role: "system", content: "Summary: invalid" },
          ],
        }),
      },
      model: {
        run: async (request) => {
          requests.push(request);
          return {
            stop: "complete",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });

    await expect(
      kernel.execute({ type: "context.compact", reason: "manual" }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        category: "compaction",
        message: "Compaction changed the stable prompt prefix",
      },
    });

    await kernel.submit("continue");
    expect(requests[0]?.messages[0]).toEqual(stablePrompt);
  });

  it("compacts and retries exactly once after an input overflow", async () => {
    const requests: ModelRequest[] = [];
    const compact = vi.fn(async () => ({
      summary: "short",
      messages: [
        stablePrompt,
        { role: "system" as const, content: "Summary: short" },
        { role: "user" as const, content: "continue" },
      ],
    }));
    const kernel = new RuntimeKernel({
      sessionId: sessionId("input-overflow-retry"),
      initialMessages: [
        stablePrompt,
        { role: "user", content: "very large prior history that must shrink" },
      ],
      stablePrefixMessageCount: 1,
      compaction: { compact },
      model: {
        run: async (request) => {
          requests.push(request);
          if (requests.length === 1)
            throw new ModelContextOverflowError("input", "prompt is too long");
          return {
            stop: "complete",
            usage: { inputTokens: 10, outputTokens: 1 },
          };
        },
      },
    });

    await kernel.submit("continue");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "overflow" }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual([
      stablePrompt,
      { role: "system", content: "Summary: short" },
      { role: "user", content: "continue" },
    ]);
  });

  it("recognizes a host-neutral RuntimeFailure input-overflow signal", async () => {
    let calls = 0;
    const compact = vi.fn(async () => ({
      summary: "short",
      messages: [
        stablePrompt,
        { role: "system" as const, content: "Summary: short" },
        { role: "user" as const, content: "continue" },
      ],
    }));
    const kernel = new RuntimeKernel({
      sessionId: sessionId("runtime-failure-input-overflow"),
      initialMessages: [
        stablePrompt,
        { role: "user", content: "large history that must shrink" },
      ],
      stablePrefixMessageCount: 1,
      compaction: { compact },
      model: {
        run: async () => {
          calls += 1;
          if (calls === 1)
            throw new RuntimeFailure(
              "provider",
              "context length exceeded",
              "unsafe",
              true,
              "public",
              "operation",
              "input-overflow",
            );
          return {
            stop: "complete",
            usage: { inputTokens: 10, outputTokens: 1 },
          };
        },
      },
    });

    await kernel.submit("continue");

    expect(calls).toBe(2);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "overflow" }),
    );
  });

  it("fails an overflow recovery when compaction makes no request-size progress", async () => {
    let calls = 0;
    const compact = vi.fn(async ({ messages }: { messages: readonly ModelMessage[] }) => ({
      summary: "unchanged",
      messages,
    }));
    const kernel = new RuntimeKernel({
      sessionId: sessionId("overflow-no-progress"),
      initialMessages: [stablePrompt, { role: "user", content: "history" }],
      stablePrefixMessageCount: 1,
      compaction: { compact },
      model: {
        run: async () => {
          calls += 1;
          throw new ModelContextOverflowError("input", "prompt is too long");
        },
      },
    });

    await expect(kernel.submit("continue")).rejects.toMatchObject({
      category: "compaction",
      message: "Context compaction made no input-size progress",
    });
    expect(calls).toBe(1);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
