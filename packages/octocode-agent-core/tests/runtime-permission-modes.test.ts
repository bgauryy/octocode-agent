import { describe, expect, it, vi } from "vitest";

import {
  RuntimeKernel,
  ToolRegistry,
  sessionId,
  type PermissionMode,
  type ToolDefinition,
} from "../src/index.js";

function tool(
  execute: () => void,
  approval: "never" | "on-request" | "always",
  effects: ToolDefinition["policy"]["effects"],
): ToolDefinition {
  return {
    name: "fixture",
    label: "Fixture",
    description: "Permission-mode fixture",
    schemaVersion: 1,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {},
    outputVersion: 1,
    policy: { effects, trust: "none", approval, plan: "allowed" },
    execute: async () => {
      execute();
      return { ok: true, content: "done", detailsVersion: 1 };
    },
  };
}

async function run(options: {
  mode: PermissionMode;
  approval: "never" | "on-request" | "always";
  effects: ToolDefinition["policy"]["effects"];
  workspace?: "trusted" | "untrusted";
  approve?: () => Promise<boolean>;
}) {
  const execute = vi.fn();
  const tools = new ToolRegistry();
  tools.register(tool(execute, options.approval, options.effects), "builtin");
  const kernel = new RuntimeKernel({
    sessionId: sessionId(`permission:${options.mode}:${options.approval}`),
    model: {
      run: async () => ({
        stop: "complete",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    tools,
    permissionMode: options.mode,
    trust: {
      workspace: options.workspace ?? "trusted",
      managedOnly: false,
    },
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  const result = await kernel.execute({
    type: "tool.execute",
    operationId: "permission-call",
    name: "fixture",
    input: {},
  });
  return { execute, result };
}

describe("runtime permission modes", () => {
  it("requires a reviewer for elevated auto risk in strict mode", async () => {
    const { execute, result } = await run({
      mode: "strict",
      approval: "never",
      effects: ["network"],
    });
    expect(result).toMatchObject({ ok: false, error: { category: "approval" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets allow-all bypass promptable approval in a trusted workspace", async () => {
    const approve = vi.fn(async () => false);
    const { execute, result } = await run({
      mode: "allow-all",
      approval: "on-request",
      effects: ["write"],
      approve,
    });
    expect(result).toMatchObject({ ok: true });
    expect(approve).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("never lets allow-all bypass mandatory approval", async () => {
    const approve = vi.fn(async () => false);
    const { execute, result } = await run({
      mode: "allow-all",
      approval: "always",
      effects: ["write"],
      approve,
    });
    expect(result).toMatchObject({ ok: false, error: { category: "approval" } });
    expect(approve).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects allow-all outside a trusted workspace", async () => {
    const { execute, result } = await run({
      mode: "allow-all",
      approval: "on-request",
      effects: ["network"],
      workspace: "untrusted",
    });
    expect(result).toMatchObject({ ok: false, error: { category: "approval" } });
    expect(execute).not.toHaveBeenCalled();
  });
});
