import { describe, expect, it } from "vitest";
import {
  RuntimeKernel,
  ToolRegistry,
  sessionId,
  type ToolExecutionInput,
} from "../src/index.js";

describe("tool admission execution context", () => {
  it("passes an integrity-bound host authority only after effect admission", async () => {
    let observed: ToolExecutionInput["context"] | undefined;
    const tools = new ToolRegistry();
    tools.register(
      {
        name: "worker",
        label: "worker",
        description: "worker",
        schemaVersion: 1,
        inputSchema: { type: "object" },
        outputSchema: {},
        outputVersion: 1,
        policy: {
          effects: ["process"],
          trust: "workspace",
          approval: "never",
          plan: "allowed",
        },
        execute: async (input) => {
          observed = input.context;
          return { ok: true, content: {}, detailsVersion: 1 };
        },
      },
      "builtin",
    );
    const authorityRoot = {
      rootAgentId: "root-agent",
      workspaceId: "workspace-sha256",
      workspaceGeneration: 4,
      ownershipGeneration: 7,
    };
    const kernel = new RuntimeKernel({
      sessionId: sessionId("authority-session"),
      model: {
        run: async () => ({
          stop: "complete",
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      },
      tools,
      trust: { workspace: "trusted", managedOnly: false },
      permissionMode: "default",
      workerAuthorityRoot: authorityRoot,
    });
    authorityRoot.workspaceGeneration = 99;

    await expect(
      kernel.execute({
        type: "tool.execute",
        operationId: "spawn-1",
        name: "worker",
        input: { action: "spawn" },
      }),
    ).resolves.toMatchObject({ ok: true });

    const admission = observed?.admission;
    expect(admission).toBeDefined();
    if (admission === undefined) throw new Error("admission context missing");
    expect(admission).toMatchObject({
      schemaVersion: 1,
      effectAdmissionId: "authority-session:external:spawn-1",
      permissionMode: "default",
      policyRevision: expect.any(Number),
      planRevision: 0,
      workerAuthorityRoot: {
        rootAgentId: "root-agent",
        workspaceId: "workspace-sha256",
        workspaceGeneration: 4,
        ownershipGeneration: 7,
      },
    });
    expect(admission.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(admission.trustRevision).toMatch(/^[a-f0-9]{64}$/u);
  });
});
