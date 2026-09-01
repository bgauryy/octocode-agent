import {
  RuntimeFailure,
  type WorkerCommand,
  type WorkerController,
  type WorkerSpawnPacket,
  type WorkerTerminalPacket,
} from "@octocodeai/agent-core";

import type {
  NativeRustWorkClaim,
  NativeRustWorkGraph,
  NativeRustWorkGraphResult,
  NativeRustWorkGraphSummary,
  NativeRustWorkSettlement,
} from "./native-rust-core.js";
import type {
  NativeWorkDagClaimRequest,
  NativeWorkDagDefinition,
} from "./native-rust-work-dag.js";
import type { PlanScope } from "./native-plan.js";

export interface NativeWorkerDagScheduleStep {
  readonly itemId: string;
  readonly prompt: string;
  readonly dependsOn: readonly string[];
}

export interface NativeWorkerDagSchedule {
  readonly graphId: string;
  readonly scope: PlanScope;
  readonly steps: readonly NativeWorkerDagScheduleStep[];
}

export interface NativeWorkerDagPlanClaim {
  readonly scope: PlanScope;
  readonly graphId: string;
  readonly itemId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly signal: AbortSignal;
}

export interface NativeWorkerDagPlanPort {
  prepare(
    scope: PlanScope,
    signal: AbortSignal,
  ): Promise<NativeWorkerDagSchedule>;
  claimItem(request: NativeWorkerDagPlanClaim): Promise<void>;
  reconcile(request: {
    readonly schedule: NativeWorkerDagSchedule;
    readonly graph: NativeRustWorkGraph;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export interface NativeWorkerDagWorkPort {
  putGraph(value: NativeWorkDagDefinition): Promise<NativeRustWorkGraphSummary>;
  getGraph(graphId: string): Promise<NativeRustWorkGraphResult>;
  claim(
    value: NativeWorkDagClaimRequest,
  ): Promise<readonly NativeRustWorkClaim[]>;
  heartbeat(
    ownership: NativeRustWorkClaim,
    now: number,
    leaseMs: number,
  ): Promise<NativeRustWorkClaim>;
  complete(
    ownership: NativeRustWorkClaim,
    completedAt: number,
    outcome: unknown,
  ): Promise<NativeRustWorkSettlement>;
  fail(
    ownership: NativeRustWorkClaim,
    completedAt: number,
    outcome: unknown,
  ): Promise<NativeRustWorkSettlement>;
}

export interface NativeWorkerDagSchedulerOptions {
  readonly work: NativeWorkerDagWorkPort;
  readonly plan: NativeWorkerDagPlanPort;
  readonly controller: WorkerController;
  readonly idFactory: () => string;
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface NativeWorkerDagRunRequest {
  readonly scope: PlanScope;
  readonly maxParallel: number;
  readonly signal: AbortSignal;
  readonly packet: (
    step: NativeWorkerDagScheduleStep,
    workerId: string,
  ) => WorkerSpawnPacket;
}

export interface NativeWorkerDagRunResult {
  readonly graphId: string;
  readonly state: "succeeded" | "failed";
  readonly items: readonly {
    readonly itemId: string;
    readonly state: NativeRustWorkGraph["items"][number]["state"];
    readonly workerId?: string;
  }[];
}

/** Narrow production/test boundary exposed to the admitted worker tool. */
export interface NativeWorkerDagSchedulerPort {
  run(request: NativeWorkerDagRunRequest): Promise<NativeWorkerDagRunResult>;
}

interface ActiveWorker {
  claim: NativeRustWorkClaim;
  packet: WorkerSpawnPacket;
  completion: Promise<WorkerTerminalPacket>;
}

const MAX_SCHEDULE_ITEMS = 32;
const MAX_PARALLEL = 4;
const DEFAULT_LEASE_MS = 30_000;

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted)
    throw new RuntimeFailure(
      "cancelled",
      "Worker dependency schedule was cancelled",
      "safe",
      true,
      "sensitive",
    );
}

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(
        new RuntimeFailure(
          "cancelled",
          "Worker dependency schedule was cancelled",
        ),
      );
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(
        new RuntimeFailure(
          "cancelled",
          "Worker dependency schedule was cancelled",
        ),
      );
    };
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateSchedule(
  value: NativeWorkerDagSchedule,
  expectedScope: PlanScope,
): NativeWorkerDagSchedule {
  if (
    typeof value !== "object" ||
    value === null ||
    value.scope.sessionId !== expectedScope.sessionId ||
    value.scope.workspace !== expectedScope.workspace ||
    typeof value.graphId !== "string" ||
    value.graphId.length === 0 ||
    value.graphId.length > 512 ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > MAX_SCHEDULE_ITEMS
  )
    throw new RuntimeFailure(
      "validation",
      "Worker dependency schedule is invalid",
    );
  const ids = new Set<string>();
  const steps = value.steps.map((step) => {
    if (
      typeof step.itemId !== "string" ||
      step.itemId.length === 0 ||
      step.itemId.length > 512 ||
      typeof step.prompt !== "string" ||
      step.prompt.length === 0 ||
      step.prompt.length > 16_384 ||
      !Array.isArray(step.dependsOn) ||
      step.dependsOn.length > MAX_SCHEDULE_ITEMS ||
      step.dependsOn.some(
        (dependency: unknown) => typeof dependency !== "string",
      ) ||
      new Set(step.dependsOn).size !== step.dependsOn.length ||
      ids.has(step.itemId)
    )
      throw new RuntimeFailure(
        "validation",
        "Worker dependency schedule step is invalid",
      );
    ids.add(step.itemId);
    return Object.freeze({
      itemId: step.itemId,
      prompt: step.prompt,
      dependsOn: Object.freeze([...step.dependsOn]),
    });
  });
  for (const step of steps)
    if (
      step.dependsOn.some(
        (dependency) => dependency === step.itemId || !ids.has(dependency),
      )
    )
      throw new RuntimeFailure(
        "validation",
        "Worker dependency schedule contains an invalid dependency",
      );
  return Object.freeze({
    graphId: value.graphId,
    scope: Object.freeze({ ...value.scope }),
    steps: Object.freeze(steps),
  });
}

function validatePacket(
  packet: WorkerSpawnPacket,
  step: NativeWorkerDagScheduleStep,
  expectedWorkerId: string,
  scope: PlanScope,
): WorkerSpawnPacket {
  if (
    packet.schemaVersion !== 1 ||
    packet.type !== "worker.spawn" ||
    packet.workerId !== expectedWorkerId ||
    String(packet.sessionId) !== scope.sessionId ||
    packet.prompt !== step.prompt ||
    packet.presentation?.planStepId !== step.itemId ||
    packet.capabilities.tools.includes("worker") ||
    (packet.capabilities.octocodeTools !== undefined &&
      !packet.capabilities.tools.includes("octocode"))
  )
    throw new RuntimeFailure(
      "validation",
      `No admitted worker packet binding exists for ${step.itemId}`,
    );
  return Object.freeze(packet);
}

function terminal(
  value: unknown,
  packet: WorkerSpawnPacket,
): WorkerTerminalPacket {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as WorkerTerminalPacket).schemaVersion !== 1 ||
    (value as WorkerTerminalPacket).type !== "worker.terminal" ||
    (value as WorkerTerminalPacket).workerId !== packet.workerId ||
    (value as WorkerTerminalPacket).correlationId !== packet.correlationId ||
    (value as WorkerTerminalPacket).sessionId !== packet.sessionId ||
    !["succeeded", "failed", "aborted", "killed"].includes(
      String((value as WorkerTerminalPacket).outcome),
    )
  )
    throw new RuntimeFailure(
      "validation",
      "Worker dependency terminal packet is invalid",
    );
  return value as WorkerTerminalPacket;
}

function sameTopology(
  schedule: NativeWorkerDagSchedule,
  graph: NativeRustWorkGraph,
): boolean {
  return (
    graph.graphId === schedule.graphId &&
    graph.items.length === schedule.steps.length &&
    graph.items.every((item, index) => {
      const expected = schedule.steps[index];
      return (
        expected !== undefined &&
        item.itemId === expected.itemId &&
        item.dependsOn.length === expected.dependsOn.length &&
        item.dependsOn.every(
          (dependency, position) => dependency === expected.dependsOn[position],
        )
      );
    })
  );
}

export class NativeWorkerDagScheduler implements NativeWorkerDagSchedulerPort {
  readonly #work: NativeWorkerDagWorkPort;
  readonly #plan: NativeWorkerDagPlanPort;
  readonly #controller: WorkerController;
  readonly #idFactory: () => string;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: NativeWorkerDagSchedulerOptions) {
    if (
      !Number.isSafeInteger(options.leaseMs ?? DEFAULT_LEASE_MS) ||
      (options.leaseMs ?? DEFAULT_LEASE_MS) < 3 ||
      (options.leaseMs ?? DEFAULT_LEASE_MS) > 86_400_000
    )
      throw new RuntimeFailure(
        "validation",
        "Worker dependency lease is invalid",
      );
    this.#work = options.work;
    this.#plan = options.plan;
    this.#controller = options.controller;
    this.#idFactory = options.idFactory;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async run(
    request: NativeWorkerDagRunRequest,
  ): Promise<NativeWorkerDagRunResult> {
    if (
      !Number.isSafeInteger(request.maxParallel) ||
      request.maxParallel < 1 ||
      request.maxParallel > MAX_PARALLEL
    )
      throw new RuntimeFailure(
        "validation",
        "Worker dependency parallelism is invalid",
      );
    abortIfNeeded(request.signal);
    const schedule = validateSchedule(
      await this.#plan.prepare(request.scope, request.signal),
      request.scope,
    );
    const byId = new Map(
      schedule.steps.map((step) => [step.itemId, step] as const),
    );
    try {
      await this.#work.putGraph({
        graphId: schedule.graphId,
        items: schedule.steps.map(({ itemId, dependsOn }) => ({
          itemId,
          dependsOn,
        })),
      });
    } catch (error) {
      if (!(error instanceof RuntimeFailure) || error.category !== "conflict")
        throw error;
    }
    let graph = await this.#requireGraph(schedule);
    await this.#plan.reconcile({ schedule, graph, signal: request.signal });
    const active = new Map<string, ActiveWorker>();
    let failed: unknown;
    try {
      for (;;) {
        abortIfNeeded(request.signal);
        while (active.size < request.maxParallel) {
          const worker = this.#idFactory();
          const [ownership] = await this.#work.claim({
            graphId: schedule.graphId,
            ownerId: worker,
            now: this.#now(),
            leaseMs: this.#leaseMs,
            limit: 1,
          });
          if (ownership === undefined) break;
          if (ownership.fencingToken > 1) {
            await this.#work.fail(ownership, this.#now(), {
              reason: "expired_claim_execution_uncertain",
            });
            graph = await this.#requireGraph(schedule);
            await this.#plan.reconcile({
              schedule,
              graph,
              signal: request.signal,
            });
            continue;
          }
          const step = byId.get(ownership.itemId);
          if (step === undefined) {
            await this.#work.fail(ownership, this.#now(), {
              reason: "missing_packet_binding",
            });
            throw new RuntimeFailure(
              "validation",
              `No admitted worker packet binding exists for ${ownership.itemId}`,
            );
          }
          let packet: WorkerSpawnPacket;
          try {
            packet = validatePacket(
              request.packet(step, worker),
              step,
              worker,
              request.scope,
            );
          } catch (error) {
            await this.#work.fail(ownership, this.#now(), {
              reason: "missing_packet_binding",
            });
            graph = await this.#requireGraph(schedule);
            await this.#plan.reconcile({
              schedule,
              graph,
              signal: request.signal,
            });
            throw error;
          }
          try {
            await this.#plan.claimItem({
              scope: request.scope,
              graphId: schedule.graphId,
              itemId: step.itemId,
              workerId: worker,
              fencingToken: ownership.fencingToken,
              signal: request.signal,
            });
            await this.#controller.execute({ type: "spawn", packet });
          } catch (error) {
            await this.#work.fail(ownership, this.#now(), {
              reason: "worker_admission_failed",
            });
            graph = await this.#requireGraph(schedule);
            await this.#plan.reconcile({
              schedule,
              graph,
              signal: request.signal,
            });
            throw error;
          }
          const completion = this.#controller
            .execute({ type: "wait", workerId: packet.workerId })
            .then((value) => terminal(value, packet));
          active.set(worker, { claim: ownership, packet, completion });
        }

        if (active.size === 0) {
          graph = await this.#requireGraph(schedule);
          await this.#plan.reconcile({
            schedule,
            graph,
            signal: request.signal,
          });
          if (
            graph.items.every(
              (item) => item.state !== "pending" && item.state !== "claimed",
            )
          )
            return this.#result(graph);
          const externalClaims = graph.items.filter(
            (item) => item.state === "claimed",
          );
          if (externalClaims.length === 0)
            throw new RuntimeFailure(
              "persistence",
              "Worker dependency graph has no claimable or active item",
              "unsafe",
              true,
              "sensitive",
            );
          const nextLease = Math.min(
            ...externalClaims.map(
              (item) => item.leaseExpiresAt ?? this.#now() + this.#leaseMs,
            ),
          );
          await this.#sleep(
            Math.max(1, nextLease - this.#now()),
            request.signal,
          );
          continue;
        }

        const heartbeatMs = Math.max(1, Math.floor(this.#leaseMs / 3));
        const raced = await Promise.race([
          ...[...active.entries()].map(([id, entry]) =>
            entry.completion.then((value) => ({
              kind: "terminal" as const,
              id,
              value,
            })),
          ),
          this.#sleep(heartbeatMs, request.signal).then(() => ({
            kind: "heartbeat" as const,
          })),
        ]);
        if (raced.kind === "heartbeat") {
          for (const entry of active.values())
            entry.claim = await this.#work.heartbeat(
              entry.claim,
              this.#now(),
              this.#leaseMs,
            );
          continue;
        }
        const entry = active.get(raced.id)!;
        if (raced.value.outcome === "succeeded")
          await this.#work.complete(entry.claim, this.#now(), {
            workerOutcome: "succeeded",
          });
        else
          await this.#work.fail(entry.claim, this.#now(), {
            workerOutcome: raced.value.outcome,
          });
        active.delete(raced.id);
        graph = await this.#requireGraph(schedule);
        await this.#plan.reconcile({ schedule, graph, signal: request.signal });
        if (
          active.size === 0 &&
          graph.items.every(
            (item) => item.state !== "pending" && item.state !== "claimed",
          )
        )
          return this.#result(graph);
      }
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      if (failed !== undefined && active.size > 0) {
        await Promise.allSettled(
          [...active.values()].map(async (entry) => {
            await this.#controller.execute({
              type: "abort",
              workerId: entry.packet.workerId,
              reason: "dependency schedule stopped",
            } satisfies WorkerCommand);
            await this.#work.fail(entry.claim, this.#now(), {
              reason: "schedule_stopped",
            });
          }),
        );
      }
    }
  }

  async #requireGraph(
    schedule: NativeWorkerDagSchedule,
  ): Promise<NativeRustWorkGraph> {
    const graph = await this.#work.getGraph(schedule.graphId);
    if (graph === null || !sameTopology(schedule, graph))
      throw new RuntimeFailure(
        "persistence",
        "Worker dependency graph does not match its immutable plan binding",
        "unsafe",
        true,
        "sensitive",
      );
    return graph;
  }

  #result(graph: NativeRustWorkGraph): NativeWorkerDagRunResult {
    return Object.freeze({
      graphId: graph.graphId,
      state: graph.items.every((item) => item.state === "succeeded")
        ? "succeeded"
        : "failed",
      items: Object.freeze(
        graph.items.map((item) =>
          Object.freeze({
            itemId: item.itemId,
            state: item.state,
            ...(item.ownerId === null ? {} : { workerId: item.ownerId }),
          }),
        ),
      ),
    });
  }
}
