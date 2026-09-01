import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  correlationId,
  packetId,
  sessionId,
  workerId,
  type WorkerCommand,
  type WorkerController,
  type WorkerSpawnPacket,
} from "@octocodeai/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeRustCoreClient } from "../src/native-rust-core.js";
import { NativeRustWorkDagStore } from "../src/native-rust-work-dag.js";
import {
  InMemoryPlanStore,
  NativePlanWorkerOwnership,
} from "../src/native-plan.js";
import {
  NativeWorkerDagScheduler,
  type NativeWorkerDagPlanPort,
  type NativeWorkerDagSchedule,
  type NativeWorkerDagWorkPort,
} from "../src/native-worker-dag-scheduler.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const scope = { sessionId: "session-1", workspace: "/workspace" } as const;
const schedule: NativeWorkerDagSchedule = {
  graphId: "plan:release",
  scope,
  steps: [
    { itemId: "build", prompt: "Build", dependsOn: [] },
    { itemId: "verify", prompt: "Verify", dependsOn: ["build"] },
  ],
};

function packet(
  step: NativeWorkerDagSchedule["steps"][number],
  id: string,
): WorkerSpawnPacket {
  return Object.freeze({
    schemaVersion: 1,
    type: "worker.spawn",
    packetId: packetId(`packet-${id}`),
    workerId: workerId(id),
    correlationId: correlationId(`correlation-${id}`),
    sessionId: sessionId(scope.sessionId),
    redaction: "sensitive",
    prompt: step.prompt,
    promptSnapshotId: "prompt-snapshot",
    workspace: { mode: "shared" as const },
    capabilities: { tools: [], models: [], maxTurns: 4 },
    presentation: { planStepId: step.itemId },
  });
}

function controller(order: string[]): WorkerController {
  const packets = new Map<string, WorkerSpawnPacket>();
  return {
    execute: vi.fn(async (command: WorkerCommand) => {
      if (command.type === "spawn") {
        order.push(`spawn:${command.packet.presentation?.planStepId}`);
        packets.set(command.packet.workerId, command.packet);
        return {
          workerId: command.packet.workerId,
          correlationId: command.packet.correlationId,
          sessionId: command.packet.sessionId,
          state: "running",
          queueDepth: 0,
          capabilities: command.packet.capabilities,
        };
      }
      if (command.type === "wait") {
        const spawned = packets.get(command.workerId)!;
        order.push(`wait:${spawned.presentation?.planStepId}`);
        return {
          schemaVersion: 1 as const,
          type: "worker.terminal",
          packetId: packetId(`terminal-${command.workerId}`),
          workerId: spawned.workerId,
          correlationId: spawned.correlationId,
          sessionId: spawned.sessionId,
          redaction: "sensitive",
          outcome: "succeeded",
        };
      }
      if (command.type === "list") return [];
      if (command.type === "status") return null;
      return undefined;
    }),
  };
}

function plan(order: string[]): NativeWorkerDagPlanPort {
  return {
    prepare: vi.fn(async () => schedule),
    claimItem: vi.fn(async ({ itemId }) => {
      order.push(`claim:${itemId}`);
    }),
    reconcile: vi.fn(
      async ({
        graph,
      }: Parameters<NativeWorkerDagPlanPort["reconcile"]>[0]) => {
        order.push(
          `reconcile:${graph.items.map((item) => item.state).join(",")}`,
        );
      },
    ),
  };
}

describe("NativeWorkerDagScheduler", () => {
  const binary = path.resolve(
    import.meta.dirname,
    "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust",
  );

  it.skipIf(!fs.existsSync(binary))(
    "dispatches plan-bound packets through the worker controller and real Rust DAG",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "octocode-worker-dag-"),
      );
      roots.push(root);
      const client = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath: path.join(root, "core.sqlite3"),
      });
      const order: string[] = [];
      const planPort = plan(order);
      const workerController = controller(order);
      let sequence = 0;
      const scheduler = new NativeWorkerDagScheduler({
        work: new NativeRustWorkDagStore(client),
        plan: planPort,
        controller: workerController,
        idFactory: () => `worker-${++sequence}`,
        now: () => 1_000 + sequence,
      });
      try {
        await expect(
          scheduler.run({
            scope,
            maxParallel: 2,
            signal: new AbortController().signal,
            packet: (step, id) => packet(step, id),
          }),
        ).resolves.toMatchObject({
          graphId: "plan:release",
          state: "succeeded",
          items: [
            { itemId: "build", state: "succeeded" },
            { itemId: "verify", state: "succeeded" },
          ],
        });
        expect(order).toEqual([
          "reconcile:pending,pending",
          "claim:build",
          "spawn:build",
          "wait:build",
          "reconcile:succeeded,pending",
          "claim:verify",
          "spawn:verify",
          "wait:verify",
          "reconcile:succeeded,succeeded",
        ]);
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(!fs.existsSync(binary))(
    "reconciles a concrete native plan to completion through the real Rust DAG",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "octocode-worker-plan-dag-"),
      );
      roots.push(root);
      const client = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath: path.join(root, "core.sqlite3"),
      });
      const work = new NativeRustWorkDagStore(client);
      const planStore = new InMemoryPlanStore();
      await planStore.save(scope, 0, {
        version: 1,
        scope,
        revision: 1,
        phase: "active",
        steps: [
          { id: "build", text: "Build", status: "done" },
          { id: "verify", text: "Verify", status: "todo", dependsOn: [1] },
        ],
        decisions: [],
      });
      const ownership = new NativePlanWorkerOwnership(planStore, work);
      let sequence = 0;
      const order: string[] = [];
      const scheduler = new NativeWorkerDagScheduler({
        work,
        plan: ownership,
        controller: controller(order),
        idFactory: () => `worker-${++sequence}`,
        now: () => 2_000 + sequence,
      });
      try {
        await expect(
          scheduler.run({
            scope,
            maxParallel: 2,
            signal: new AbortController().signal,
            packet: (step, id) => packet(step, id),
          }),
        ).resolves.toMatchObject({ state: "succeeded" });
        await expect(planStore.load(scope)).resolves.toMatchObject({
          phase: "complete",
          steps: [
            { id: "build", status: "done" },
            { id: "verify", status: "done" },
          ],
        });
        expect(order).toEqual(["spawn:verify", "wait:verify"]);
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(!fs.existsSync(binary))(
    "fails the claimed item and blocks descendants when packet binding violates leaf policy",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "octocode-worker-bind-dag-"),
      );
      roots.push(root);
      const client = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath: path.join(root, "core.sqlite3"),
      });
      const work = new NativeRustWorkDagStore(client);
      const workerController = controller([]);
      const scheduler = new NativeWorkerDagScheduler({
        work,
        plan: plan([]),
        controller: workerController,
        idFactory: () => "worker-1",
        now: () => 3_000,
      });
      try {
        await expect(
          scheduler.run({
            scope,
            maxParallel: 1,
            signal: new AbortController().signal,
            packet: (step, id) => ({
              ...packet(step, id),
              capabilities: { tools: ["worker"], models: [], maxTurns: 1 },
            }),
          }),
        ).rejects.toMatchObject({ category: "validation" });
        await expect(work.getGraph(schedule.graphId)).resolves.toMatchObject({
          items: [
            { itemId: "build", state: "failed" },
            { itemId: "verify", state: "blocked", blockedBy: ["build"] },
          ],
        });
        expect(workerController.execute).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(!fs.existsSync(binary))(
    "never replays an expired claim whose prior worker execution is uncertain",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "octocode-worker-takeover-dag-"),
      );
      roots.push(root);
      const client = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath: path.join(root, "core.sqlite3"),
      });
      const work = new NativeRustWorkDagStore(client);
      await work.putGraph({
        graphId: schedule.graphId,
        items: schedule.steps.map(({ itemId, dependsOn }) => ({
          itemId,
          dependsOn,
        })),
      });
      await work.claim({
        graphId: schedule.graphId,
        ownerId: "crashed-worker",
        now: 100,
        leaseMs: 5,
        limit: 1,
      });
      const workerController = controller([]);
      const scheduler = new NativeWorkerDagScheduler({
        work,
        plan: plan([]),
        controller: workerController,
        idFactory: () => "replacement-worker",
        now: () => 200,
      });
      try {
        await expect(
          scheduler.run({
            scope,
            maxParallel: 1,
            signal: new AbortController().signal,
            packet: (step, id) => packet(step, id),
          }),
        ).resolves.toMatchObject({
          state: "failed",
          items: [
            { itemId: "build", state: "failed" },
            { itemId: "verify", state: "blocked" },
          ],
        });
        expect(workerController.execute).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    },
  );

  it("heartbeats active Rust claims before their lease expires", async () => {
    const oneStep: NativeWorkerDagSchedule = {
      graphId: "plan:heartbeat",
      scope,
      steps: [{ itemId: "build", prompt: "Build", dependsOn: [] }],
    };
    const claim = {
      schemaVersion: 1 as const,
      graphId: oneStep.graphId,
      itemId: "build",
      state: "claimed" as const,
      ownerId: "worker-1",
      leaseExpiresAt: 1_030,
      fencingToken: 1,
    };
    let state: "pending" | "claimed" | "succeeded" = "pending";
    const graph = () => ({
      schemaVersion: 1 as const,
      graphId: oneStep.graphId,
      items: [
        {
          itemId: "build",
          ordinal: 0,
          dependsOn: [],
          state,
          fencingToken: state === "pending" ? 0 : 1,
          ownerId: state === "claimed" ? "worker-1" : null,
          leaseExpiresAt: state === "claimed" ? 1_030 : null,
          outcome:
            state === "succeeded" ? { workerOutcome: "succeeded" } : null,
          blockedBy: [],
        },
      ],
    });
    let finishWorker!: (value: unknown) => void;
    let spawned: WorkerSpawnPacket | undefined;
    const work: NativeWorkerDagWorkPort = {
      putGraph: vi.fn(async () => ({
        schemaVersion: 1 as const,
        graphId: oneStep.graphId,
        itemCount: 1,
      })),
      getGraph: vi.fn(async () => graph()),
      claim: vi.fn(async () => {
        if (state !== "pending") return [];
        state = "claimed";
        return [claim];
      }),
      heartbeat: vi.fn(async () => {
        finishWorker({
          schemaVersion: 1 as const,
          type: "worker.terminal",
          packetId: packetId("terminal-worker-1"),
          workerId: spawned!.workerId,
          correlationId: spawned!.correlationId,
          sessionId: spawned!.sessionId,
          redaction: "sensitive",
          outcome: "succeeded",
        });
        return { ...claim, leaseExpiresAt: 1_060 };
      }),
      complete: vi.fn(async (_ownership, _completedAt, outcome) => {
        state = "succeeded";
        return {
          schemaVersion: 1 as const,
          graphId: oneStep.graphId,
          itemId: "build",
          state: "succeeded" as const,
          fencingToken: 1,
          outcome,
        };
      }),
      fail: vi.fn(),
    };
    const workerController: WorkerController = {
      execute: vi.fn(async (command: WorkerCommand) => {
        if (command.type === "spawn") {
          spawned = command.packet;
          return {
            workerId: command.packet.workerId,
            correlationId: command.packet.correlationId,
            sessionId: command.packet.sessionId,
            state: "running",
            queueDepth: 0,
            capabilities: command.packet.capabilities,
          };
        }
        if (command.type === "wait")
          return new Promise((resolve) => {
            finishWorker = resolve;
          });
        return undefined;
      }),
    };
    let sleepCount = 0;
    const scheduler = new NativeWorkerDagScheduler({
      work,
      plan: {
        prepare: vi.fn(async () => oneStep),
        claimItem: vi.fn(async () => undefined),
        reconcile: vi.fn(async () => undefined),
      },
      controller: workerController,
      idFactory: () => "worker-1",
      now: () => 1_000,
      leaseMs: 30,
      sleep: () => {
        sleepCount += 1;
        return sleepCount === 1
          ? Promise.resolve()
          : new Promise(() => undefined);
      },
    });

    await expect(
      scheduler.run({
        scope,
        maxParallel: 1,
        signal: new AbortController().signal,
        packet: (step, id) => packet(step, id),
      }),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(work.heartbeat).toHaveBeenCalledTimes(1);
    expect(work.complete).toHaveBeenCalledTimes(1);
  });

  it("fails a claimed item before execution when no immutable packet binding exists", async () => {
    const work: NativeWorkerDagWorkPort = {
      putGraph: vi.fn(async () => ({
        schemaVersion: 1 as const,
        graphId: schedule.graphId,
        itemCount: schedule.steps.length,
      })),
      getGraph: vi.fn(async () => ({
        schemaVersion: 1 as const,
        graphId: schedule.graphId,
        items: schedule.steps.map((step, ordinal) => ({
          itemId: step.itemId,
          ordinal,
          dependsOn: step.dependsOn,
          state: "pending" as const,
          fencingToken: 0,
          ownerId: null,
          leaseExpiresAt: null,
          outcome: null,
          blockedBy: [],
        })),
      })),
      claim: vi.fn(async () => [
        {
          schemaVersion: 1 as const,
          graphId: schedule.graphId,
          itemId: "unbound",
          state: "claimed" as const,
          ownerId: "worker-1",
          leaseExpiresAt: 31_000,
          fencingToken: 1,
        },
      ]),
      heartbeat: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(async (ownership, _completedAt, outcome) => ({
        schemaVersion: 1 as const,
        graphId: ownership.graphId,
        itemId: ownership.itemId,
        state: "failed" as const,
        fencingToken: ownership.fencingToken,
        outcome: outcome as null,
      })),
    };
    const workerController = controller([]);
    const scheduler = new NativeWorkerDagScheduler({
      work,
      plan: plan([]),
      controller: workerController,
      idFactory: () => "worker-1",
      now: () => 1_000,
    });

    await expect(
      scheduler.run({
        scope,
        maxParallel: 1,
        signal: new AbortController().signal,
        packet: (step, id) => packet(step, id),
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(work.fail).toHaveBeenCalledTimes(1);
    expect(workerController.execute).not.toHaveBeenCalled();
  });
});
