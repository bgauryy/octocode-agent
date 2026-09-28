import { describe, expect, it, vi } from "vitest";

import {
  createOctocodeToolRegistry,
  OctocodeFacadeError,
  type OctocodeCatalog,
} from "../src/native-tools.js";

const catalog: OctocodeCatalog = {
  kind: "octocode.toolCatalog.full",
  version: 1,
  toolCount: 2,
  tools: [
    {
      name: "localSearch",
      description: "Search local code",
      category: "Local",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    {
      name: "ghSearch",
      description: "Search GitHub",
      category: "GitHub",
      inputSchema: { type: "object" },
    },
  ],
};

function execution(input: unknown, signal = new AbortController().signal) {
  return {
    input,
    callId: "call:octocode" as never,
    context: {
      sessionId: "session" as never,
      cwd: "/tmp",
      mode: "headless" as const,
      trust: { workspace: "trusted" as const, managedOnly: false },
      signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

describe("compact Octocode facade", () => {
  it("registers one model-facing facade while retaining native base tools", () => {
    const registry = createOctocodeToolRegistry(catalog, vi.fn());
    expect(registry.list().map(({ name }) => name)).toEqual([
      "octocode",
      "plan",
    ]);
  });

  it("lists compact metadata, returns one exact schema, and validates calls", async () => {
    const execute = vi.fn(async () => ({ value: "ok" }));
    const tool = createOctocodeToolRegistry(catalog, execute).get("octocode")!;

    await expect(tool.execute(execution({ action: "catalog" }))).resolves.toMatchObject({
      content: {
        tools: [
          { name: "ghSearch" },
          { name: "localSearch" },
        ],
      },
    });
    await expect(
      tool.execute(
        execution({ action: "schema", tool: "localSearch" }),
      ),
    ).resolves.toMatchObject({
      content: { name: "localSearch", inputSchema: { type: "object" } },
    });
    await expect(
      tool.execute(
        execution({
          action: "call",
          tool: "localSearch",
          input: { query: 42 },
        }),
      ),
    ).rejects.toMatchObject({
      code: "execution-invalid",
      message: expect.stringContaining('{"action":"schema","tool":"localSearch"}'),
    });
  });

  it("runs 1-8 ordered calls with at most four active executors", async () => {
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async (_name: string, input: unknown) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { value: String((input as { query: string }).query) };
    });
    const tool = createOctocodeToolRegistry(catalog, execute).get("octocode")!;
    const result = await tool.execute(
      execution({
        action: "parallel",
        calls: Array.from({ length: 8 }, (_, index) => ({
          tool: "localSearch",
          input: { query: String(index) },
        })),
        maxConcurrency: 4,
      }),
    );

    expect(peak).toBe(4);
    expect(result.content).toMatchObject({
      results: Array.from({ length: 8 }, (_, index) => ({
        tool: "localSearch",
        content: { value: String(index) },
      })),
    });
  });

  it("shares one four-wide executor pool across parallel and action-specific facade lanes", async () => {
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async (_name: string, input: unknown) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { value: String((input as { query: string }).query) };
    });
    const tool = createOctocodeToolRegistry(catalog, execute).get("octocode")!;
    const parallel = tool.execute(
      execution({
        action: "parallel",
        calls: Array.from({ length: 8 }, (_, index) => ({
          tool: "localSearch",
          input: { query: `parallel-${index}` },
        })),
        maxConcurrency: 4,
      }),
    );
    const singles = Array.from({ length: 4 }, (_, index) =>
      tool.execute(
        execution({
          action: "call",
          tool: "localSearch",
          input: { query: `single-${index}` },
        }),
      ),
    );

    await Promise.all([parallel, ...singles]);

    expect(peak).toBe(4);
  });

  it("preflights every parallel inner schema before starting any executor", async () => {
    const execute = vi.fn(async () => ({ value: "should-not-run" }));
    const tool = createOctocodeToolRegistry(catalog, execute).get("octocode")!;

    await expect(
      tool.execute(
        execution({
          action: "parallel",
          calls: [
            { tool: "localSearch", input: { query: "valid" } },
            { tool: "localSearch", input: { query: 42 } },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "execution-invalid" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels a queued inner call without admitting its executor", async () => {
    let started = 0;
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saturated = new Promise<void>((resolve) => { ready = resolve; });
    const execute = vi.fn(async (_name: string, input: unknown) => {
      started += 1;
      if (started === 4) ready();
      await gate;
      return { value: String((input as { query: string }).query) };
    });
    const tool = createOctocodeToolRegistry(catalog, execute).get("octocode")!;
    const occupying = tool.execute(
      execution({
        action: "parallel",
        calls: Array.from({ length: 4 }, (_, index) => ({
          tool: "localSearch",
          input: { query: `occupying-${index}` },
        })),
      }),
    );
    await saturated;
    const controller = new AbortController();
    const queued = tool.execute(
      execution(
        { action: "call", tool: "localSearch", input: { query: "queued" } },
        controller.signal,
      ),
    );

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "execution-cancelled" });
    expect(started).toBe(4);
    release();
    await occupying;
  });

  it("rejects cross-action fields and parallel concurrency above four", async () => {
    const tool = createOctocodeToolRegistry(catalog, vi.fn()).get("octocode")!;
    await expect(
      tool.execute(execution({ action: "catalog", tool: "localSearch" })),
    ).rejects.toMatchObject({ code: "execution-invalid" });
    await expect(
      tool.execute(
        execution({
          action: "parallel",
          calls: [{ tool: "localSearch", input: { query: "x" } }],
          maxConcurrency: 5,
        }),
      ),
    ).rejects.toMatchObject({ code: "execution-invalid" });
  });

  it("keeps delegated underlying capabilities fail-closed", async () => {
    const registry = createOctocodeToolRegistry(catalog, vi.fn(), {
      allowedTools: new Set(["octocode"]),
      allowedOctocodeTools: new Set(["localSearch"]),
    });
    const tool = registry.get("octocode")!;
    expect(registry.list().map(({ name }) => name)).toEqual(["octocode"]);
    await expect(
      tool.execute(
        execution({ action: "call", tool: "ghSearch", input: {} }),
      ),
    ).rejects.toBeInstanceOf(OctocodeFacadeError);
  });

  it("uses exact known classifications and conservatively gates unknown catalog additions", () => {
    const registry = createOctocodeToolRegistry(
      {
        kind: "octocode.toolCatalog.full",
        version: 1,
        toolCount: 2,
        tools: [
          {
            name: "ghCloneRepo",
            description: "Clone a repository",
            category: "Local",
            inputSchema: { type: "object" },
          },
          {
            name: "futureTool",
            description: "Unknown future capability",
            category: "Local",
            inputSchema: { type: "object" },
          },
        ],
      },
      vi.fn(),
    );
    const resolve = registry.get("octocode")!.policy.resolve!;
    expect(
      resolve({ action: "call", tool: "ghCloneRepo", input: {} }),
    ).toEqual({
      effects: ["network", "process", "write"],
      trust: "workspace",
      approval: "on-request",
    });
    expect(
      resolve({ action: "call", tool: "futureTool", input: {} }),
    ).toEqual({
      effects: ["network", "process", "write"],
      trust: "workspace",
      approval: "on-request",
    });
  });
});
