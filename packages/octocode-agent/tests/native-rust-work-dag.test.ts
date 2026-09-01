import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeFailure } from "@octocodeai/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NativeRustCoreClient,
  NativeRustCoreError,
} from "../src/native-rust-core.js";
import {
  NativeRustWorkDagStore,
  type RustWorkDagClient,
} from "../src/native-rust-work-dag.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fakeClient(): RustWorkDagClient {
  return {
    workPutGraph: vi.fn(async ({ graphId, items }) => ({
      schemaVersion: 1,
      graphId,
      itemCount: items.length,
    })),
    workGetGraph: vi.fn(async ({ graphId }) => ({
      schemaVersion: 1,
      graphId,
      items: [
        {
          itemId: "root",
          ordinal: 0,
          dependsOn: [],
          state: "pending",
          fencingToken: 0,
          ownerId: null,
          leaseExpiresAt: null,
          outcome: null,
          blockedBy: [],
        },
      ],
    })),
    workClaim: vi.fn(async ({ graphId, ownerId, now, leaseMs }) => [
      {
        schemaVersion: 1,
        graphId,
        itemId: "root",
        state: "claimed",
        ownerId,
        leaseExpiresAt: now + leaseMs,
        fencingToken: 1,
      },
    ]),
    workHeartbeat: vi.fn(async (input) => ({
      schemaVersion: 1,
      graphId: input.graphId,
      itemId: input.itemId,
      state: "claimed",
      ownerId: input.ownerId,
      leaseExpiresAt: input.now + input.leaseMs,
      fencingToken: input.fencingToken,
    })),
    workComplete: vi.fn(async (input) => ({
      schemaVersion: 1,
      graphId: input.graphId,
      itemId: input.itemId,
      state: "succeeded",
      fencingToken: input.fencingToken,
      outcome: input.outcome,
    })),
    workFail: vi.fn(async (input) => ({
      schemaVersion: 1,
      graphId: input.graphId,
      itemId: input.itemId,
      state: "failed",
      fencingToken: input.fencingToken,
      outcome: input.outcome,
    })),
  };
}

describe("NativeRustWorkDagStore", () => {
  it("validates a graph and preserves fenced ownership through settlement", async () => {
    const client = fakeClient();
    const store = new NativeRustWorkDagStore(client);

    await expect(
      store.putGraph({
        graphId: "release",
        items: [{ itemId: "root", dependsOn: [] }],
      }),
    ).resolves.toEqual({ schemaVersion: 1, graphId: "release", itemCount: 1 });
    await expect(store.getGraph("release")).resolves.toMatchObject({
      graphId: "release",
      items: [{ itemId: "root", state: "pending" }],
    });
    const [claim] = await store.claim({
      graphId: "release",
      ownerId: "native-agent",
      now: 1_000,
      leaseMs: 30_000,
      limit: 1,
    });
    expect(claim).toMatchObject({ itemId: "root", fencingToken: 1 });
    await expect(store.heartbeat(claim!, 2_000, 30_000)).resolves.toMatchObject(
      {
        leaseExpiresAt: 32_000,
        fencingToken: 1,
      },
    );
    await expect(
      store.complete(claim!, 2_500, { workerOutcome: "succeeded" }),
    ).resolves.toMatchObject({
      state: "succeeded",
      outcome: { workerOutcome: "succeeded" },
    });
  });

  it("rejects invalid graphs before crossing the Rust boundary", async () => {
    const client = fakeClient();
    const store = new NativeRustWorkDagStore(client);

    await expect(
      store.putGraph({
        graphId: "cycle",
        items: [
          { itemId: "a", dependsOn: ["b"] },
          { itemId: "b", dependsOn: ["a"] },
        ],
      }),
    ).rejects.toMatchObject({
      category: "validation",
    } satisfies Partial<RuntimeFailure>);
    await expect(
      store.putGraph({
        graphId: "payload-bypass",
        items: [
          {
            itemId: "root",
            dependsOn: [],
            command: "execute-outside-policy",
          },
        ],
      } as unknown as Parameters<NativeRustWorkDagStore["putGraph"]>[0]),
    ).rejects.toMatchObject({
      category: "validation",
    } satisfies Partial<RuntimeFailure>);
    expect(client.workPutGraph).not.toHaveBeenCalled();
  });

  it("enforces UTF-8 and outcome budgets before native calls", async () => {
    const client = fakeClient();
    const store = new NativeRustWorkDagStore(client);

    await expect(
      store.putGraph({
        graphId: "🙂".repeat(129),
        items: [{ itemId: "root", dependsOn: [] }],
      }),
    ).rejects.toMatchObject({
      category: "validation",
    } satisfies Partial<RuntimeFailure>);
    await expect(
      store.complete(
        {
          schemaVersion: 1,
          graphId: "release",
          itemId: "root",
          state: "claimed",
          ownerId: "native-agent",
          leaseExpiresAt: 31_000,
          fencingToken: 1,
        },
        2_500,
        { output: "x".repeat(65 * 1024) },
      ),
    ).rejects.toMatchObject({
      category: "validation",
    } satisfies Partial<RuntimeFailure>);
    expect(client.workPutGraph).not.toHaveBeenCalled();
    expect(client.workComplete).not.toHaveBeenCalled();
  });

  it("fails closed on malformed durable responses", async () => {
    const client = fakeClient();
    vi.mocked(client.workClaim).mockResolvedValueOnce([
      {
        schemaVersion: 1,
        graphId: "release",
        itemId: "root",
        state: "claimed",
        ownerId: "other-owner",
        leaseExpiresAt: 31_000,
        fencingToken: 1,
      },
    ]);
    const store = new NativeRustWorkDagStore(client);

    await expect(
      store.claim({
        graphId: "release",
        ownerId: "native-agent",
        now: 1_000,
        leaseMs: 30_000,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      category: "persistence",
    } satisfies Partial<RuntimeFailure>);
  });

  it("maps stale fencing failures to conflicts without retrying", async () => {
    const client = fakeClient();
    vi.mocked(client.workHeartbeat).mockRejectedValueOnce(
      new NativeRustCoreError("remote", "stale lease", "CONFLICT"),
    );
    const store = new NativeRustWorkDagStore(client);

    await expect(
      store.heartbeat(
        {
          schemaVersion: 1,
          graphId: "release",
          itemId: "root",
          state: "claimed",
          ownerId: "native-agent",
          leaseExpiresAt: 31_000,
          fencingToken: 1,
        },
        2_000,
        30_000,
      ),
    ).rejects.toMatchObject({
      category: "conflict",
    } satisfies Partial<RuntimeFailure>);
    expect(client.workHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("observes cancellation before crossing the process boundary", async () => {
    const client = fakeClient();
    const controller = new AbortController();
    controller.abort("stop");
    const store = new NativeRustWorkDagStore(client, controller.signal);

    await expect(store.getGraph("release")).rejects.toMatchObject({
      category: "cancelled",
    } satisfies Partial<RuntimeFailure>);
    expect(client.workGetGraph).not.toHaveBeenCalled();
  });

  const binary = path.resolve(
    import.meta.dirname,
    "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust",
  );

  it.skipIf(!fs.existsSync(binary))(
    "runs dependency ordering and stale-owner fencing through the real Rust process",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-work-dag-"));
      roots.push(root);
      const client = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath: path.join(root, "core.sqlite3"),
      });
      const store = new NativeRustWorkDagStore(client);
      try {
        await store.putGraph({
          graphId: "release",
          items: [
            { itemId: "build", dependsOn: [] },
            { itemId: "verify", dependsOn: ["build"] },
            { itemId: "publish", dependsOn: ["verify"] },
          ],
        });
        const [build] = await store.claim({
          graphId: "release",
          ownerId: "owner-a",
          now: 100,
          leaseMs: 10,
          limit: 1,
        });
        expect(build?.itemId).toBe("build");
        await expect(
          store.claim({
            graphId: "release",
            ownerId: "owner-b",
            now: 105,
            leaseMs: 10,
            limit: 1,
          }),
        ).resolves.toEqual([]);
        const [takeover] = await store.claim({
          graphId: "release",
          ownerId: "owner-b",
          now: 110,
          leaseMs: 10,
          limit: 1,
        });
        expect(takeover).toMatchObject({ itemId: "build", fencingToken: 2 });
        await expect(store.heartbeat(build!, 111, 10)).rejects.toMatchObject({
          category: "conflict",
        } satisfies Partial<RuntimeFailure>);
        await store.complete(takeover!, 112, { workerOutcome: "succeeded" });
        const [verify] = await store.claim({
          graphId: "release",
          ownerId: "owner-b",
          now: 113,
          leaseMs: 10,
          limit: 1,
        });
        expect(verify?.itemId).toBe("verify");
        await store.fail(verify!, 114, { workerOutcome: "failed" });
        await expect(store.getGraph("release")).resolves.toMatchObject({
          items: [
            { itemId: "build", state: "succeeded", fencingToken: 2 },
            { itemId: "verify", state: "failed", fencingToken: 1 },
            {
              itemId: "publish",
              state: "blocked",
              blockedBy: ["verify"],
            },
          ],
        });
      } finally {
        await client.close();
      }
    },
  );
});
