import { RuntimeFailure } from "../contracts/errors.js";
import { packetId, type WorkerId } from "../contracts/identity.js";
import type {
  WorkerHandle,
  WorkerCommand,
  WorkerController,
  WorkerLedgerEntry,
  WorkerLedgerPort,
  WorkerOperationalProgress,
  WorkerPacket,
  WorkerPort,
  WorkerSnapshot,
  WorkerSpawnPacket,
  WorkerState,
  WorkerStateEntry,
  WorkerSupervisorSnapshot,
  WorkerTerminalOutcome,
  WorkerTerminalPacket,
  WorkerWorktreePort,
} from "../contracts/workers.js";

interface WorkerRecord {
  readonly spawn: WorkerSpawnPacket;
  readonly controller: AbortController;
  readonly pending: WorkerPacket[];
  readonly completion: Promise<WorkerTerminalPacket>;
  readonly resolve: (packet: WorkerTerminalPacket) => void;
  readonly reject: (error: RuntimeFailure) => void;
  state: WorkerState;
  handle?: WorkerHandle;
  terminal?: WorkerTerminalPacket;
  occupiesSlot: boolean;
  ledgerTail: Promise<void>;
  finalizing?: Promise<void>;
  joinRequested?: boolean;
  joining?: Promise<void>;
}

export interface WorkerSupervisorOptions {
  readonly port: WorkerPort;
  readonly ledger?: WorkerLedgerPort;
  readonly maxActive: number;
  readonly shutdownGraceMs?: number;
  readonly worktrees?: WorkerWorktreePort;
  readonly onStarted?: (snapshot: WorkerSnapshot) => void | Promise<void>;
  readonly onStopped?: (snapshot: WorkerSnapshot) => void | Promise<void>;
  readonly onProgress?: (
    progress: WorkerOperationalProgress,
  ) => void | Promise<void>;
}

const terminalState = (outcome: WorkerTerminalOutcome): WorkerState => outcome;
const isTerminal = (state: WorkerState): boolean =>
  state === "succeeded" ||
  state === "failed" ||
  state === "aborted" ||
  state === "killed";

export class WorkerSupervisor implements WorkerController {
  readonly #records = new Map<WorkerId, WorkerRecord>();
  readonly #queue: WorkerRecord[] = [];
  readonly #port: WorkerPort;
  readonly #ledger?: WorkerLedgerPort;
  readonly #maxActive: number;
  readonly #shutdownGraceMs: number;
  readonly #worktrees?: WorkerWorktreePort;
  readonly #onStarted?: WorkerSupervisorOptions["onStarted"];
  readonly #onStopped?: WorkerSupervisorOptions["onStopped"];
  readonly #onProgress?: WorkerSupervisorOptions["onProgress"];
  #active = 0;
  #state: WorkerSupervisorSnapshot["state"] = "running";

  constructor(options: WorkerSupervisorOptions) {
    if (!Number.isSafeInteger(options.maxActive) || options.maxActive < 1)
      throw new RuntimeFailure(
        "validation",
        "Worker maxActive must be a positive integer",
      );
    if (
      options.shutdownGraceMs !== undefined &&
      (!Number.isSafeInteger(options.shutdownGraceMs) ||
        options.shutdownGraceMs < 0)
    )
      throw new RuntimeFailure(
        "validation",
        "Worker shutdownGraceMs must be a non-negative integer",
      );
    this.#port = options.port;
    this.#ledger = options.ledger;
    this.#maxActive = options.maxActive;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    this.#worktrees = options.worktrees;
    this.#onStarted = options.onStarted;
    this.#onStopped = options.onStopped;
    this.#onProgress = options.onProgress;
  }

  async spawn(packet: WorkerSpawnPacket): Promise<WorkerSnapshot> {
    if (this.#state !== "running")
      throw new RuntimeFailure(
        "conflict",
        "Worker supervisor is shutting down",
      );
    this.#validateSpawn(packet);
    if (packet.workspace.mode === "worktree" && this.#worktrees === undefined)
      throw new RuntimeFailure(
        "unsupported-capability",
        "Worker worktree isolation is unavailable",
      );
    if (this.#records.has(packet.workerId))
      throw new RuntimeFailure(
        "conflict",
        `Duplicate worker: ${packet.workerId}`,
      );
    packet = this.#snapshotSpawn(packet);
    let resolve!: (terminal: WorkerTerminalPacket) => void;
    let reject!: (error: RuntimeFailure) => void;
    const completion = new Promise<WorkerTerminalPacket>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    void completion.catch(() => undefined);
    const record: WorkerRecord = {
      spawn: packet,
      controller: new AbortController(),
      pending: [],
      completion,
      resolve,
      reject,
      state: "queued",
      occupiesSlot: false,
      ledgerTail: Promise.resolve(),
    };
    this.#records.set(packet.workerId, record);
    this.#queue.push(record);
    try {
      await this.#append(record, packet);
      await this.#recordState(record, "queued");
      await this.#notifyProgress(record, "queued");
    } catch (error) {
      this.#records.delete(packet.workerId);
      this.#removeQueued(record);
      throw error;
    }
    const snapshot = this.#snapshot(record);
    this.#pump();
    return snapshot;
  }

  list(): readonly WorkerSnapshot[] {
    return [...this.#records.values()].map((record) => this.#snapshot(record));
  }
  status(id: WorkerId): WorkerSnapshot | null {
    const record = this.#records.get(id);
    return record === undefined ? null : this.#snapshot(record);
  }
  async wait(id: WorkerId): Promise<WorkerTerminalPacket> {
    const record = this.#require(id);
    record.joinRequested = true;
    await this.#join(record);
    return record.completion;
  }

  async send(packet: WorkerPacket): Promise<void> {
    await this.#input(packet, "worker.send");
  }
  async steer(packet: WorkerPacket): Promise<void> {
    await this.#input(packet, "worker.steer");
  }
  async followUp(packet: WorkerPacket): Promise<void> {
    await this.#input(packet, "worker.follow-up");
  }

  async execute(command: WorkerCommand): Promise<unknown> {
    switch (command.type) {
      case "spawn":
        return this.spawn(command.packet);
      case "list":
        return this.list();
      case "status":
        return this.status(command.workerId);
      case "wait":
        return this.wait(command.workerId);
      case "abort":
        await this.abort(command.workerId, command.reason);
        return undefined;
      case "kill":
        await this.kill(command.workerId, command.reason);
        return undefined;
      case "send":
        await this.send(command.packet);
        return undefined;
      case "steer":
        await this.steer(command.packet);
        return undefined;
      case "follow-up":
        await this.followUp(command.packet);
        return undefined;
      case "shutdown":
        await this.shutdown(command.reason);
        return undefined;
    }
  }

  async abort(id: WorkerId, reason = "aborted"): Promise<void> {
    const record = this.#require(id);
    if (record.finalizing !== undefined) {
      await record.finalizing;
      return;
    }
    if (isTerminal(record.state)) return;
    if (
      record.state === "queued" ||
      (record.state === "starting" && record.handle === undefined)
    ) {
      record.controller.abort(reason);
      await this.#finalize(record, this.#terminal(record, "aborted", reason));
      return;
    }
    if (record.state === "aborting" || record.state === "killing") return;
    await this.#recordState(record, "aborting");
    record.controller.abort(reason);
    try {
      await record.handle?.abort(reason);
    } catch {
      await this.#finalize(
        record,
        this.#terminal(record, "failed", "Worker abort failed"),
      );
    }
  }

  async kill(id: WorkerId, reason = "killed"): Promise<void> {
    const record = this.#require(id);
    if (record.finalizing !== undefined) {
      await record.finalizing;
      return;
    }
    if (isTerminal(record.state)) return;
    await this.#recordState(record, "killing");
    record.controller.abort(reason);
    try {
      await record.handle?.kill(reason);
    } catch {
      /* A dead transport is compatible with forced termination. */
    }
    await this.#finalize(record, this.#terminal(record, "killed", reason));
  }

  snapshot(): WorkerSupervisorSnapshot {
    return {
      state: this.#state,
      active: this.#active,
      queued: this.#queue.filter((record) => record.state === "queued").length,
      maxActive: this.#maxActive,
    };
  }

  async shutdown(reason = "supervisor shutdown"): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state === "stopping") {
      await Promise.all(
        [...this.#records.values()]
          .filter((record) => !isTerminal(record.state))
          .map((record) => record.completion),
      );
      return;
    }
    this.#state = "stopping";
    const pending = [...this.#records.values()].filter(
      (record) => !isTerminal(record.state),
    );
    await Promise.all(
      pending.map((record) => this.abort(record.spawn.workerId, reason)),
    );
    const remaining = pending.filter((record) => !isTerminal(record.state));
    if (remaining.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.#shutdownGraceMs);
      });
      const joined = Promise.all(
        remaining.map((record) => record.completion),
      ).then(() => "joined" as const);
      const outcome = await Promise.race([joined, grace]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "timeout")
        await Promise.all(
          remaining
            .filter((record) => !isTerminal(record.state))
            .map((record) => this.kill(record.spawn.workerId, reason)),
        );
    }
    await Promise.all(pending.map((record) => record.completion));
    this.#state = "stopped";
  }

  #pump(): void {
    if (this.#state !== "running") return;
    while (this.#active < this.#maxActive) {
      const record = this.#queue.shift();
      if (record === undefined) return;
      if (record.state !== "queued") continue;
      record.occupiesSlot = true;
      this.#active += 1;
      void this.#launch(record).catch(() => undefined);
    }
  }

  async #launch(record: WorkerRecord): Promise<void> {
    await this.#recordState(record, "starting");
    await this.#notifyProgress(record, "queued");
    if (isTerminal(record.state)) return;
    let handle: WorkerHandle;
    try {
      if (record.spawn.workspace.mode === "worktree")
        await this.#worktrees?.prepare(record.spawn, record.controller.signal);
      handle = await this.#port.spawn(record.spawn, record.controller.signal);
    } catch {
      await this.#finalize(
        record,
        this.#terminal(record, "failed", "Worker crashed"),
      );
      return;
    }
    record.handle = handle;
    void this.#observe(record, handle).catch(() => undefined);
    if (isTerminal(record.state)) {
      try {
        if (record.state === "killed")
          await handle.kill(record.terminal?.reason ?? "killed");
        else await handle.abort(record.terminal?.reason ?? "aborted");
      } catch {
        /* The record already has its exactly-once terminal state. */
      }
      return;
    }
    await this.#recordState(record, "running");
    await this.#notifyProgress(record, "running");
    try {
      await this.#onStarted?.(this.#snapshot(record));
    } catch {
      /* Lifecycle observers cannot orphan a running worker. */
    }
    while (record.pending.length > 0 && record.state === "running") {
      const packet = record.pending.shift();
      if (packet !== undefined) {
        try {
          await handle.send(packet);
        } catch {
          await this.#finalize(
            record,
            this.#terminal(record, "failed", "Worker transport failed"),
          );
        }
      }
    }
    if (record.joinRequested === true) await this.#join(record);
  }

  async #join(record: WorkerRecord): Promise<void> {
    if (record.handle === undefined || isTerminal(record.state)) return;
    if (record.joining === undefined) {
      record.joining = record.handle.join().catch(async () => {
        await this.#finalize(
          record,
          this.#terminal(record, "failed", "Worker join failed"),
        );
      });
    }
    await record.joining;
  }

  async #observe(record: WorkerRecord, handle: WorkerHandle): Promise<void> {
    try {
      const terminal = await handle.completion;
      if (!this.#validTerminal(record, terminal)) {
        await this.#finalize(
          record,
          this.#terminal(
            record,
            "failed",
            "Worker returned an invalid terminal packet",
          ),
        );
        return;
      }
      await this.#finalize(record, terminal);
    } catch {
      await this.#finalize(
        record,
        this.#terminal(record, "failed", "Worker crashed"),
      );
    }
  }

  async #input(
    packet: WorkerPacket,
    expected: WorkerPacket["type"],
  ): Promise<void> {
    if (packet.type !== expected)
      throw new RuntimeFailure("validation", `Expected ${expected} packet`);
    const record = this.#require(packet.workerId);
    if (!this.#matches(record, packet))
      throw new RuntimeFailure(
        "validation",
        "Worker packet correlation does not match spawn packet",
      );
    if (record.finalizing !== undefined)
      throw new RuntimeFailure(
        "conflict",
        `Worker ${record.spawn.workerId} is completing`,
      );
    if (record.joinRequested === true)
      throw new RuntimeFailure(
        "conflict",
        `Worker ${record.spawn.workerId} is joining`,
      );
    if (
      isTerminal(record.state) ||
      record.state === "aborting" ||
      record.state === "killing"
    )
      throw new RuntimeFailure(
        "conflict",
        `Worker ${record.spawn.workerId} is not accepting input`,
      );
    const immutable = Object.freeze({ ...packet });
    await this.#append(record, immutable);
    if (record.handle === undefined || record.state !== "running") {
      record.pending.push(immutable);
      return;
    }
    try {
      await record.handle.send(immutable);
    } catch {
      await this.#finalize(
        record,
        this.#terminal(record, "failed", "Worker transport failed"),
      );
    }
  }

  async #recordState(record: WorkerRecord, state: WorkerState): Promise<void> {
    if (record.finalizing !== undefined) {
      await record.finalizing;
      return;
    }
    if (isTerminal(record.state)) return;
    const previous = record.state;
    const entry: WorkerStateEntry = {
      schemaVersion: 1,
      type: "worker.state",
      packetId: packetId(`state:${record.spawn.workerId}:${state}`),
      workerId: record.spawn.workerId,
      correlationId: record.spawn.correlationId,
      sessionId: record.spawn.sessionId,
      redaction: record.spawn.redaction,
      state,
    };
    try {
      await this.#append(record, entry);
    } catch (error) {
      this.#failSupervisor(this.#ledgerFailure(error));
      throw error;
    }
    if (record.state === previous) record.state = state;
  }

  async #finalize(
    record: WorkerRecord,
    terminal: WorkerTerminalPacket,
  ): Promise<void> {
    if (record.terminal !== undefined) return;
    if (record.finalizing !== undefined) {
      await record.finalizing;
      return;
    }
    const immutable = Object.freeze({ ...terminal });
    record.finalizing = (async () => {
      try {
        await this.#append(record, immutable);
        record.terminal = immutable;
        record.state = terminalState(immutable.outcome);
        record.pending.length = 0;
        if (record.occupiesSlot) {
          record.occupiesSlot = false;
          this.#active -= 1;
        }
        await this.#notifyProgress(record, immutable.outcome);
        if (record.spawn.workspace.mode === "worktree") {
          try {
            await this.#worktrees?.release(record.spawn, immutable);
          } catch {
            /* Cleanup is fail-closed by retaining the worktree; terminal settlement remains authoritative. */
          }
        }
        try {
          await this.#onStopped?.(this.#snapshot(record));
        } catch {
          /* Lifecycle observers cannot erase authoritative terminal state. */
        }
        record.resolve(immutable);
        this.#pump();
      } catch (error) {
        const failure = this.#ledgerFailure(error);
        this.#failSupervisor(failure);
        throw failure;
      }
    })();
    await record.finalizing;
  }

  #terminal(
    record: WorkerRecord,
    outcome: WorkerTerminalOutcome,
    reason: string,
  ): WorkerTerminalPacket {
    return {
      schemaVersion: 1,
      type: "worker.terminal",
      packetId: packetId(`terminal:${record.spawn.workerId}:${outcome}`),
      workerId: record.spawn.workerId,
      correlationId: record.spawn.correlationId,
      sessionId: record.spawn.sessionId,
      redaction: record.spawn.redaction,
      outcome,
      reason,
    };
  }

  #matches(
    record: WorkerRecord,
    packet: Pick<WorkerPacket, "workerId" | "correlationId" | "sessionId">,
  ): boolean {
    return (
      packet.workerId === record.spawn.workerId &&
      packet.correlationId === record.spawn.correlationId &&
      packet.sessionId === record.spawn.sessionId
    );
  }

  #validTerminal(record: WorkerRecord, packet: WorkerTerminalPacket): boolean {
    return (
      packet.schemaVersion === 1 &&
      packet.type === "worker.terminal" &&
      packet.packetId.length > 0 &&
      (packet.outcome === "succeeded" ||
        packet.outcome === "failed" ||
        packet.outcome === "aborted" ||
        packet.outcome === "killed") &&
      this.#matches(record, packet)
    );
  }

  #snapshot(record: WorkerRecord): WorkerSnapshot {
    return {
      workerId: record.spawn.workerId,
      correlationId: record.spawn.correlationId,
      sessionId: record.spawn.sessionId,
      state: record.state,
      queueDepth: record.pending.length,
      capabilities: record.spawn.capabilities,
      ...(record.terminal === undefined ? {} : { terminal: record.terminal }),
    };
  }

  async #notifyProgress(
    record: WorkerRecord,
    state: WorkerOperationalProgress["state"],
  ): Promise<void> {
    const metadata = record.spawn.presentation;
    const progress: WorkerOperationalProgress = Object.freeze({
      workerId: record.spawn.workerId,
      state,
      active: this.#active,
      queued: this.#queue.filter((candidate) => candidate.state === "queued")
        .length,
      maxActive: this.#maxActive,
      ...(metadata?.agentType === undefined
        ? {}
        : { agentType: metadata.agentType }),
      ...(metadata?.planStepId === undefined
        ? {}
        : { planStepId: metadata.planStepId }),
      ...(metadata?.taskLabel === undefined
        ? {}
        : { taskLabel: metadata.taskLabel }),
    });
    try {
      await this.#onProgress?.(progress);
    } catch {
      /* Presentation observers cannot change authoritative worker state. */
    }
  }

  #require(id: WorkerId): WorkerRecord {
    const record = this.#records.get(id);
    if (record === undefined)
      throw new RuntimeFailure("validation", `Unknown worker: ${id}`);
    return record;
  }

  #validateSpawn(packet: WorkerSpawnPacket): void {
    if (
      packet.schemaVersion !== 1 ||
      packet.type !== "worker.spawn" ||
      packet.workerId.length === 0 ||
      packet.correlationId.length === 0 ||
      packet.sessionId.length === 0 ||
      packet.packetId.length === 0 ||
      packet.prompt.length === 0 ||
      packet.promptSnapshotId.length === 0
    )
      throw new RuntimeFailure("validation", "Malformed worker spawn packet");
    if (
      !Number.isSafeInteger(packet.capabilities.maxTurns) ||
      packet.capabilities.maxTurns < 1
    )
      throw new RuntimeFailure(
        "validation",
        "Worker maxTurns must be a positive integer",
      );
    if (packet.capabilities.tools.includes("worker"))
      throw new RuntimeFailure(
        "validation",
        "Worker children cannot receive recursive worker capability",
      );
    if (
      packet.capabilities.octocodeTools !== undefined &&
      !packet.capabilities.tools.includes("octocode")
    )
      throw new RuntimeFailure(
        "validation",
        "Worker Octocode capabilities require the Octocode facade",
      );
    if (
      packet.workspace.mode === "worktree" &&
      (packet.workspace.path.length === 0 ||
        packet.workspace.baseRevision.length === 0)
    )
      throw new RuntimeFailure(
        "validation",
        "Worker worktree identity is incomplete",
      );
    if (packet.presentation !== undefined) {
      const metadata = packet.presentation as Record<string, unknown>;
      if (
        !Object.keys(metadata).every(
          (key) =>
            key === "agentType" || key === "planStepId" || key === "taskLabel",
        )
      )
        throw new RuntimeFailure(
          "validation",
          "Worker presentation metadata contains unsupported fields",
        );
      for (const [name, value] of Object.entries(metadata)) {
        if (
          typeof value !== "string" ||
          value.trim().length === 0 ||
          value.length > 128 ||
          /[\r\n\0]/u.test(value)
        )
          throw new RuntimeFailure(
            "validation",
            `Worker presentation ${name} is invalid`,
          );
      }
    }
  }

  #snapshotSpawn(packet: WorkerSpawnPacket): WorkerSpawnPacket {
    const capabilities = Object.freeze({
      tools: Object.freeze([...packet.capabilities.tools]),
      ...(packet.capabilities.octocodeTools === undefined
        ? {}
        : {
            octocodeTools: Object.freeze([
              ...packet.capabilities.octocodeTools,
            ]),
          }),
      models: Object.freeze(
        packet.capabilities.models.map((model) => Object.freeze({ ...model })),
      ),
      maxTurns: packet.capabilities.maxTurns,
    });
    const workspace = Object.freeze({ ...packet.workspace });
    const presentation =
      packet.presentation === undefined
        ? undefined
        : Object.freeze({
            ...(packet.presentation.agentType === undefined
              ? {}
              : { agentType: packet.presentation.agentType }),
            ...(packet.presentation.planStepId === undefined
              ? {}
              : { planStepId: packet.presentation.planStepId }),
            ...(packet.presentation.taskLabel === undefined
              ? {}
              : { taskLabel: packet.presentation.taskLabel }),
          });
    return Object.freeze({
      ...packet,
      capabilities,
      workspace,
      ...(presentation === undefined ? {} : { presentation }),
    });
  }

  async #append(record: WorkerRecord, entry: WorkerLedgerEntry): Promise<void> {
    if (this.#ledger === undefined) return;
    const write = record.ledgerTail.then(() => this.#ledger?.append(entry));
    record.ledgerTail = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      throw this.#ledgerFailure(error);
    }
  }

  #ledgerFailure(error: unknown): RuntimeFailure {
    return error instanceof RuntimeFailure && error.category === "persistence"
      ? error
      : new RuntimeFailure(
          "persistence",
          "Worker ledger append failed",
          "safe",
          true,
          "sensitive",
          "runtime",
        );
  }

  #failSupervisor(failure: RuntimeFailure): void {
    if (this.#state === "failed") return;
    this.#state = "failed";
    this.#queue.length = 0;
    for (const record of this.#records.values()) {
      if (record.terminal !== undefined) continue;
      record.controller.abort(failure);
      record.state = "failed";
      record.pending.length = 0;
      record.occupiesSlot = false;
      record.reject(failure);
      if (record.handle !== undefined)
        void record.handle.kill("Worker ledger failed").catch(() => undefined);
    }
    this.#active = 0;
  }

  #removeQueued(record: WorkerRecord): void {
    const index = this.#queue.indexOf(record);
    if (index >= 0) this.#queue.splice(index, 1);
  }
}
