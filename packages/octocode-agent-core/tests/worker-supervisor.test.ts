import { describe, expect, it, vi } from "vitest";
import {
  WorkerSupervisor,
  correlationId,
  packetId,
  sessionId,
  workerId,
  type WorkerHandle,
  type WorkerLedgerEntry,
  type WorkerPacket,
  type WorkerPort,
  type WorkerSpawnPacket,
  type WorkerTerminalPacket,
} from "../src/index.js";

interface ControlledWorker {
  readonly handle: WorkerHandle;
  readonly packets: WorkerPacket[];
  readonly join: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
  finish(packet: WorkerTerminalPacket): void;
  crash(error: Error): void;
}

const spawnPacket = (id: string): WorkerSpawnPacket => {
  const worker = workerId(id);
  const correlation = correlationId(`correlation:${id}`);
  const session = sessionId(`session:${id}`);
  return {
    schemaVersion: 1,
    type: "worker.spawn",
    packetId: packetId(`spawn:${id}`),
    workerId: worker,
    correlationId: correlation,
    sessionId: session,
    prompt: `work ${id}`,
    promptSnapshotId: `prompt:${id}`,
    workspace: { mode: "shared" },
    redaction: "sensitive",
    authority: {
      schemaVersion: 1,
      workerId: worker,
      correlationId: correlation,
      rootAgentId: "root-agent",
      parentSessionId: session,
      workspaceId: "workspace",
      workspaceGeneration: 1,
      trustRevision: "trust-1",
      permissionMode: "default",
      capabilityDigest: "capabilities-1",
      effectAdmissionId: "effect-1",
      ownershipGeneration: 1,
    },
    capabilities: {
      tools: ["localSearch"],
      models: [{ providerId: "openai", modelId: "gpt" }],
      maxTurns: 4,
    },
  };
};

const terminalPacket = (
  spawn: WorkerSpawnPacket,
  outcome: WorkerTerminalPacket["outcome"],
): WorkerTerminalPacket => ({
  schemaVersion: 1,
  type: "worker.terminal",
  packetId: packetId(`terminal:${spawn.workerId}`),
  workerId: spawn.workerId,
  correlationId: spawn.correlationId,
  sessionId: spawn.sessionId,
  redaction: spawn.redaction,
  authority: spawn.authority,
  outcome,
  ...(outcome === "succeeded"
    ? { handback: { summary: "done" } }
    : { reason: outcome }),
});

const controlled = (): ControlledWorker => {
  let resolve!: (packet: WorkerTerminalPacket) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<WorkerTerminalPacket>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  const packets: WorkerPacket[] = [];
  const join = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const kill = vi.fn(async () => undefined);
  return {
    packets,
    join,
    abort,
    kill,
    handle: {
      send: async (packet) => {
        packets.push(packet);
      },
      join,
      abort,
      kill,
      completion,
    },
    finish: resolve,
    crash: reject,
  };
};

const tick = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

describe("WorkerSupervisor", () => {
  it("rejects recursive worker capability and preserves delegated Octocode capabilities", async () => {
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => controlled().handle },
      maxActive: 1,
    });
    const recursiveBase = spawnPacket("recursive");
    const recursive: WorkerSpawnPacket = {
      ...recursiveBase,
      capabilities: {
        ...recursiveBase.capabilities,
        tools: [...recursiveBase.capabilities.tools, "worker"],
      },
    };
    await expect(supervisor.spawn(recursive)).rejects.toMatchObject({
      category: "validation",
    });

    const leafBase = spawnPacket("leaf");
    const leaf: WorkerSpawnPacket = {
      ...leafBase,
      capabilities: {
        ...leafBase.capabilities,
        tools: [...leafBase.capabilities.tools, "octocode"],
        octocodeTools: ["localSearch"],
      },
    };
    await expect(supervisor.spawn(leaf)).resolves.toMatchObject({
      capabilities: { octocodeTools: ["localSearch"] },
    });
  });

  it("seals a live worker exactly once when wait joins it", async () => {
    const worker = controlled();
    const packet = spawnPacket("join");
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      maxActive: 1,
    });
    await supervisor.spawn(packet);
    await tick();

    const first = supervisor.wait(packet.workerId, packet.authority);
    const second = supervisor.wait(packet.workerId, packet.authority);
    await tick();
    expect(worker.join).toHaveBeenCalledOnce();
    await expect(
      supervisor.send({
        schemaVersion: 1,
        type: "worker.send",
        packetId: packetId("after-join"),
        workerId: packet.workerId,
        correlationId: packet.correlationId,
        sessionId: packet.sessionId,
        redaction: "public",
        authority: packet.authority,
        text: "too late",
      }),
    ).rejects.toMatchObject({ category: "conflict" });
    await supervisor.abort(
      packet.workerId,
      packet.authority,
      "stop joined worker",
    );
    expect(worker.abort).toHaveBeenCalledOnce();
    worker.finish(terminalPacket(packet, "aborted"));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("reports exactly one canonical start and stop boundary per worker", async () => {
    const worker = controlled();
    const started = vi.fn();
    const stopped = vi.fn();
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      maxActive: 1,
      onStarted: started,
      onStopped: stopped,
    });
    const packet = spawnPacket("lifecycle");
    await supervisor.spawn(packet);
    await tick();
    expect(started).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: packet.workerId, state: "running" }),
    );
    worker.finish(terminalPacket(packet, "succeeded"));
    await supervisor.wait(packet.workerId, packet.authority);
    expect(stopped).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: packet.workerId,
        state: "succeeded",
      }),
    );
  });

  it("projects bounded queued, running, and terminal operational progress with aggregate capacity", async () => {
    const firstWorker = controlled();
    const secondWorker = controlled();
    let starts = 0;
    const progress = vi.fn();
    const supervisor = new WorkerSupervisor({
      port: {
        spawn: async () =>
          ++starts === 1 ? firstWorker.handle : secondWorker.handle,
      },
      maxActive: 1,
      onProgress: progress,
    });
    const first = {
      ...spawnPacket("progress-one"),
      presentation: {
        planStepId: "step-research",
        taskLabel: "Research worker",
      },
    };
    const second = spawnPacket("progress-two");

    await supervisor.spawn(first);
    await supervisor.spawn(second);
    await tick();

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: first.workerId,
        state: "running",
        active: 1,
        queued: 1,
        maxActive: 1,
        planStepId: "step-research",
        taskLabel: "Research worker",
      }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: second.workerId,
        state: "queued",
        active: 1,
        queued: 1,
        maxActive: 1,
      }),
    );

    firstWorker.finish(terminalPacket(first, "succeeded"));
    await supervisor.wait(first.workerId, first.authority);
    await tick();
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: first.workerId,
        state: "succeeded",
        active: 0,
        queued: 1,
        maxActive: 1,
      }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: second.workerId,
        state: "running",
        active: 1,
        queued: 0,
        maxActive: 1,
      }),
    );
    expect(JSON.stringify(progress.mock.calls)).not.toContain(
      "work progress-one",
    );
  });

  it("enforces active concurrency and drains queued workers in FIFO order", async () => {
    const workers = new Map<string, ControlledWorker>();
    const starts: string[] = [];
    const port: WorkerPort = {
      spawn: async (packet) => {
        starts.push(packet.workerId);
        const worker = controlled();
        workers.set(packet.workerId, worker);
        return worker.handle;
      },
    };
    const supervisor = new WorkerSupervisor({ port, maxActive: 1 });
    const first = spawnPacket("one");
    const second = spawnPacket("two");

    await supervisor.spawn(first);
    await supervisor.spawn(second);
    await tick();
    expect(starts).toEqual(["one"]);
    expect(supervisor.status(second.workerId, second.authority)?.state).toBe(
      "queued",
    );

    workers.get("one")?.finish(terminalPacket(first, "succeeded"));
    await supervisor.wait(first.workerId, first.authority);
    await tick();
    expect(starts).toEqual(["one", "two"]);
    expect(supervisor.list().map(({ workerId: id }) => id)).toEqual([
      "one",
      "two",
    ]);
  });

  it("preserves queued send, steer, and follow-up order until the worker is live", async () => {
    const first = controlled();
    const second = controlled();
    let starts = 0;
    const supervisor = new WorkerSupervisor({
      port: {
        spawn: async () => (++starts === 1 ? first.handle : second.handle),
      },
      maxActive: 1,
    });
    const a = spawnPacket("a");
    const b = spawnPacket("b");
    await supervisor.spawn(a);
    await supervisor.spawn(b);
    await tick();
    const input = (
      type: "worker.send" | "worker.steer" | "worker.follow-up",
      sequence: number,
    ): WorkerPacket => ({
      schemaVersion: 1,
      type,
      packetId: packetId(`input:${sequence}`),
      workerId: b.workerId,
      correlationId: b.correlationId,
      sessionId: b.sessionId,
      redaction: "public",
      authority: b.authority,
      text: String(sequence),
    });
    await supervisor.send(input("worker.send", 1));
    await supervisor.steer(input("worker.steer", 2));
    await supervisor.followUp(input("worker.follow-up", 3));
    expect(supervisor.status(b.workerId, b.authority)?.queueDepth).toBe(3);

    first.finish(terminalPacket(a, "succeeded"));
    await supervisor.wait(a.workerId, a.authority);
    await tick();
    expect(second.packets.map(({ type }) => type)).toEqual([
      "worker.send",
      "worker.steer",
      "worker.follow-up",
    ]);
    expect(supervisor.status(b.workerId, b.authority)?.queueDepth).toBe(0);
  });

  it("aborts queued workers without spawning them and normalizes crashes", async () => {
    const live = controlled();
    let starts = 0;
    const entries: WorkerLedgerEntry[] = [];
    const supervisor = new WorkerSupervisor({
      port: {
        spawn: async () => {
          starts += 1;
          return live.handle;
        },
      },
      maxActive: 1,
      ledger: {
        append: async (entry) => {
          entries.push(entry);
        },
      },
    });
    const a = spawnPacket("a");
    const b = spawnPacket("b");
    await supervisor.spawn(a);
    await supervisor.spawn(b);
    await tick();
    await supervisor.abort(b.workerId, b.authority, "not needed");
    expect((await supervisor.wait(b.workerId, b.authority)).outcome).toBe(
      "aborted",
    );
    expect(starts).toBe(1);

    live.crash(new Error("secret subprocess detail"));
    const terminal = await supervisor.wait(a.workerId, a.authority);
    expect(terminal).toMatchObject({
      outcome: "failed",
      reason: "Worker crashed",
    });
    expect(JSON.stringify(terminal)).not.toContain("secret subprocess detail");
    expect(
      entries.filter(
        (entry) =>
          entry.type === "worker.terminal" && entry.workerId === a.workerId,
      ),
    ).toHaveLength(1);
  });

  it("kills reliably and ignores a late terminal packet", async () => {
    const worker = controlled();
    const entries: WorkerLedgerEntry[] = [];
    const spawn = spawnPacket("kill");
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      maxActive: 1,
      ledger: {
        append: async (entry) => {
          entries.push(entry);
        },
      },
    });
    await supervisor.spawn(spawn);
    await tick();
    await supervisor.kill(spawn.workerId, spawn.authority, "deadline");
    expect(
      (await supervisor.wait(spawn.workerId, spawn.authority)).outcome,
    ).toBe("killed");
    worker.finish(terminalPacket(spawn, "succeeded"));
    await tick();
    expect(
      supervisor.status(spawn.workerId, spawn.authority)?.terminal?.outcome,
    ).toBe("killed");
    expect(
      entries.filter(({ type }) => type === "worker.terminal"),
    ).toHaveLength(1);
    expect(worker.kill).toHaveBeenCalledOnce();
  });

  it("rejects packets whose worker, session, or correlation does not match", async () => {
    const worker = controlled();
    const spawn = spawnPacket("bound");
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      maxActive: 1,
    });
    await supervisor.spawn(spawn);
    await tick();
    const wrong: WorkerPacket = {
      schemaVersion: 1,
      type: "worker.send",
      packetId: packetId("wrong"),
      workerId: spawn.workerId,
      correlationId: correlationId("different"),
      sessionId: spawn.sessionId,
      redaction: "public",
      authority: spawn.authority,
      text: "nope",
    };
    await expect(supervisor.send(wrong)).rejects.toMatchObject({
      category: "validation",
    });
    expect(worker.packets).toEqual([]);
  });

  it("performs joined shutdown and escalates workers that do not abort", async () => {
    vi.useFakeTimers();
    try {
      const a = controlled();
      const b = controlled();
      let starts = 0;
      const supervisor = new WorkerSupervisor({
        port: { spawn: async () => (++starts === 1 ? a.handle : b.handle) },
        maxActive: 2,
        shutdownGraceMs: 25,
      });
      const pa = spawnPacket("a");
      const pb = spawnPacket("b");
      await supervisor.spawn(pa);
      await supervisor.spawn(pb);
      await tick();
      const shutdown = supervisor.shutdown("exit");
      await tick();
      expect(a.abort).toHaveBeenCalledOnce();
      expect(b.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      await shutdown;
      expect(a.kill).toHaveBeenCalledOnce();
      expect(b.kill).toHaveBeenCalledOnce();
      expect(supervisor.snapshot()).toMatchObject({
        state: "stopped",
        active: 0,
        queued: 0,
      });
      await expect(supervisor.spawn(spawnPacket("late"))).rejects.toMatchObject(
        { category: "conflict" },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("provides one command surface, snapshots prompt identity, and fails closed for worktrees", async () => {
    const worker = controlled();
    const original = spawnPacket("command");
    const supervisor = new WorkerSupervisor({
      port: {
        spawn: async (packet) => {
          expect(packet.promptSnapshotId).toBe("prompt:command");
          expect(packet.capabilities.tools).toEqual(["localSearch"]);
          return worker.handle;
        },
      },
      maxActive: 1,
    });
    await expect(
      supervisor.execute({
        type: "spawn",
        packet: {
          ...spawnPacket("worktree"),
          workspace: {
            mode: "worktree",
            path: "/tmp/worktree",
            baseRevision: "abc",
          },
        },
      }),
    ).rejects.toMatchObject({ category: "unsupported-capability" });
    const spawned = supervisor.execute({ type: "spawn", packet: original });
    (original.capabilities.tools as string[]).push("mutated");
    await spawned;
    await tick();
    expect(
      await supervisor.execute({
        type: "status",
        workerId: original.workerId,
        authority: original.authority,
      }),
    ).toMatchObject({ state: "running" });
    worker.finish(terminalPacket(original, "succeeded"));
    expect(
      await supervisor.execute({
        type: "wait",
        workerId: original.workerId,
        authority: original.authority,
      }),
    ).toMatchObject({ outcome: "succeeded" });
  });

  it("routes worktree preparation and terminal release through the lifecycle port", async () => {
    const worker = controlled();
    const entries: WorkerLedgerEntry[] = [];
    const spawn = {
      ...spawnPacket("isolated"),
      workspace: {
        mode: "worktree" as const,
        path: "/caller/untrusted",
        baseRevision: "abc",
      },
    };
    const prepare = vi.fn(async (packet: WorkerSpawnPacket) => ({
      ...packet,
      workspace: {
        mode: "worktree" as const,
        path: "/contained/isolated",
        baseRevision: "resolved-abc",
      },
    }));
    const release = vi.fn(async () => undefined);
    const port = { spawn: vi.fn(async () => worker.handle) };
    const supervisor = new WorkerSupervisor({
      port,
      worktrees: { prepare, release },
      ledger: { append: async (entry) => void entries.push(entry) },
      maxActive: 1,
    });
    await supervisor.spawn(spawn);
    await tick();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: spawn.workerId }),
      expect.any(AbortSignal),
    );
    expect(port.spawn).toHaveBeenCalledOnce();
    expect(port.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
          mode: "worktree",
          path: "/contained/isolated",
          baseRevision: "resolved-abc",
        },
      }),
      expect.any(AbortSignal),
    );
    expect(entries[0]).toMatchObject({
      type: "worker.spawn",
      workspace: {
        mode: "worktree",
        path: "/contained/isolated",
        baseRevision: "resolved-abc",
      },
    });
    expect(JSON.stringify(entries)).not.toContain("/caller/untrusted");
    const terminal = terminalPacket(spawn, "succeeded");
    worker.finish(terminal);
    await expect(
      supervisor.wait(spawn.workerId, spawn.authority),
    ).resolves.toMatchObject({
      outcome: "succeeded",
    });
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: spawn.workerId }),
      terminal,
    );
  });

  it("settles terminal waiters and continues scheduling when fail-closed worktree cleanup retains state", async () => {
    const firstWorker = controlled();
    const secondWorker = controlled();
    const first = {
      ...spawnPacket("cleanup-fails"),
      workspace: {
        mode: "worktree" as const,
        path: "/contained/dirty",
        baseRevision: "abc",
      },
    };
    const second = spawnPacket("after-cleanup");
    const port = {
      spawn: vi.fn(async (packet: WorkerSpawnPacket) =>
        packet.workerId === first.workerId
          ? firstWorker.handle
          : secondWorker.handle,
      ),
    };
    const supervisor = new WorkerSupervisor({
      port,
      worktrees: {
        prepare: async (packet) => packet,
        release: async () => {
          throw new Error("dirty worktree retained");
        },
      },
      maxActive: 1,
    });
    await supervisor.spawn(first);
    await supervisor.spawn(second);
    await tick();
    firstWorker.finish(terminalPacket(first, "succeeded"));
    await expect(
      supervisor.wait(first.workerId, first.authority),
    ).resolves.toMatchObject({
      outcome: "succeeded",
    });
    await tick();
    expect(supervisor.snapshot()).toMatchObject({
      state: "running",
      active: 1,
      queued: 0,
    });
    expect(port.spawn).toHaveBeenCalledTimes(2);
    secondWorker.finish(terminalPacket(second, "succeeded"));
    await expect(
      supervisor.wait(second.workerId, second.authority),
    ).resolves.toMatchObject({
      outcome: "succeeded",
    });
  });

  it("rolls back an unpublished spawn when its first ledger write fails", async () => {
    const spawn = spawnPacket("ledger-spawn");
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => controlled().handle },
      maxActive: 1,
      ledger: {
        append: async () => {
          throw new Error("disk unavailable");
        },
      },
    });
    await expect(supervisor.spawn(spawn)).rejects.toMatchObject({
      category: "persistence",
    });
    expect(supervisor.status(spawn.workerId, spawn.authority)).toBeNull();
    expect(supervisor.snapshot()).toMatchObject({
      state: "running",
      active: 0,
      queued: 0,
    });
  });

  it("fails closed when a durable state transition cannot commit", async () => {
    const spawn = spawnPacket("ledger-state");
    let processStarts = 0;
    const supervisor = new WorkerSupervisor({
      port: {
        spawn: async () => {
          processStarts += 1;
          return controlled().handle;
        },
      },
      maxActive: 1,
      ledger: {
        append: async (entry) => {
          if (entry.type === "worker.state" && entry.state === "starting")
            throw new Error("disk unavailable");
        },
      },
    });
    await supervisor.spawn(spawn);
    await tick();
    await expect(
      supervisor.wait(spawn.workerId, spawn.authority),
    ).rejects.toMatchObject({
      category: "persistence",
    });
    expect(processStarts).toBe(0);
    expect(supervisor.snapshot()).toMatchObject({
      state: "failed",
      active: 0,
      queued: 0,
    });
  });

  it("rejects all waiters exactly once when a terminal ledger commit fails", async () => {
    const worker = controlled();
    const spawn = spawnPacket("ledger-terminal");
    let terminalWrites = 0;
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      maxActive: 1,
      ledger: {
        append: async (entry) => {
          if (entry.type === "worker.terminal") {
            terminalWrites += 1;
            throw new Error("disk unavailable");
          }
        },
      },
    });
    await supervisor.spawn(spawn);
    await tick();
    const first = supervisor.wait(spawn.workerId, spawn.authority);
    const second = supervisor.wait(spawn.workerId, spawn.authority);
    worker.finish(terminalPacket(spawn, "succeeded"));
    await expect(first).rejects.toMatchObject({ category: "persistence" });
    await expect(second).rejects.toMatchObject({ category: "persistence" });
    expect(terminalWrites).toBe(1);
    expect(supervisor.status(spawn.workerId, spawn.authority)?.state).toBe(
      "failed",
    );
    expect(
      supervisor.status(spawn.workerId, spawn.authority)?.terminal,
    ).toBeUndefined();
    expect(worker.kill).toHaveBeenCalledOnce();
  });

  it("rejects stale worker authority before ledger or transport mutation", async () => {
    const worker = controlled();
    const entries: WorkerLedgerEntry[] = [];
    const base = spawnPacket("authority");
    const authority = {
      schemaVersion: 1 as const,
      workerId: base.workerId,
      correlationId: base.correlationId,
      rootAgentId: "root-agent",
      parentSessionId: base.sessionId,
      workspaceId: "workspace",
      workspaceGeneration: 1,
      trustRevision: "trust-1",
      permissionMode: "default" as const,
      capabilityDigest: "capabilities-1",
      effectAdmissionId: "effect-1",
      ownershipGeneration: 1,
    };
    const spawn = { ...base, authority } as unknown as WorkerSpawnPacket;
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      ledger: { append: async (entry) => void entries.push(entry) },
      maxActive: 1,
    });
    await supervisor.spawn(spawn);
    await tick();
    const writesBefore = entries.length;

    await expect(
      supervisor.send({
        schemaVersion: 1,
        type: "worker.send",
        packetId: packetId("stale-authority"),
        workerId: spawn.workerId,
        correlationId: spawn.correlationId,
        sessionId: spawn.sessionId,
        redaction: "public",
        text: "must not arrive",
        authority: { ...authority, ownershipGeneration: 2 },
      } as unknown as WorkerPacket),
    ).rejects.toMatchObject({ category: "conflict" });
    expect(entries).toHaveLength(writesBefore);
    expect(worker.packets).toEqual([]);
  });

  it("deduplicates identical packet retries and conflicts on changed content", async () => {
    const worker = controlled();
    const spawn = spawnPacket("idempotent");
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      maxActive: 1,
    });
    await supervisor.spawn(spawn);
    await tick();
    const packet: WorkerPacket = {
      schemaVersion: 1,
      type: "worker.send",
      packetId: packetId("retry-id"),
      workerId: spawn.workerId,
      correlationId: spawn.correlationId,
      sessionId: spawn.sessionId,
      redaction: "public",
      authority: spawn.authority,
      text: "once",
    };

    await supervisor.send(packet);
    await supervisor.send({ ...packet });
    expect(worker.packets).toEqual([packet]);
    await expect(
      supervisor.send({ ...packet, text: "changed" }),
    ).rejects.toMatchObject({ category: "conflict" });
    expect(worker.packets).toEqual([packet]);
  });

  it("fences status, wait, abort, and kill before worker mutation", async () => {
    const worker = controlled();
    const spawn = spawnPacket("control-authority");
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle },
      maxActive: 1,
    });
    await supervisor.spawn(spawn);
    await tick();
    const stale = { ...spawn.authority, trustRevision: "stale-trust" };

    expect(() => supervisor.status(spawn.workerId, stale)).toThrowError(
      expect.objectContaining({ category: "conflict" }),
    );
    await expect(supervisor.wait(spawn.workerId, stale)).rejects.toMatchObject({
      category: "conflict",
    });
    await expect(
      supervisor.abort(spawn.workerId, stale, "unauthorized"),
    ).rejects.toMatchObject({ category: "conflict" });
    await expect(
      supervisor.kill(spawn.workerId, stale, "unauthorized"),
    ).rejects.toMatchObject({ category: "conflict" });
    expect(worker.join).not.toHaveBeenCalled();
    expect(worker.abort).not.toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(supervisor.status(spawn.workerId, spawn.authority)?.state).toBe(
      "running",
    );
  });

  it("deduplicates queued and late-terminal retries", async () => {
    const firstWorker = controlled();
    const secondWorker = controlled();
    let starts = 0;
    const supervisor = new WorkerSupervisor({
      port: {
        spawn: async () => (++starts === 1 ? firstWorker.handle : secondWorker.handle),
      },
      maxActive: 1,
    });
    const first = spawnPacket("retry-first");
    const second = spawnPacket("retry-queued");
    await supervisor.spawn(first);
    await supervisor.spawn(second);
    const packet: WorkerPacket = {
      schemaVersion: 1,
      type: "worker.send",
      packetId: packetId("queued-retry"),
      workerId: second.workerId,
      correlationId: second.correlationId,
      sessionId: second.sessionId,
      redaction: "public",
      authority: second.authority,
      text: "once while queued",
    };
    await supervisor.send(packet);
    await supervisor.send({ ...packet });
    expect(supervisor.status(second.workerId, second.authority)?.queueDepth).toBe(
      1,
    );

    firstWorker.finish(terminalPacket(first, "succeeded"));
    await supervisor.wait(first.workerId, first.authority);
    await tick();
    expect(secondWorker.packets).toHaveLength(1);
    secondWorker.finish(terminalPacket(second, "succeeded"));
    await supervisor.wait(second.workerId, second.authority);
    await expect(supervisor.send({ ...packet })).resolves.toBeUndefined();
    await expect(
      supervisor.send({ ...packet, text: "changed after terminal" }),
    ).rejects.toMatchObject({ category: "conflict" });
    expect(secondWorker.packets).toHaveLength(1);
  });

  it("returns the prior spawn result for an identical retry", async () => {
    const worker = controlled();
    const spawn = spawnPacket("spawn-retry");
    const port = { spawn: vi.fn(async () => worker.handle) };
    const supervisor = new WorkerSupervisor({ port, maxActive: 1 });

    const first = await supervisor.spawn(spawn);
    const retry = await supervisor.spawn({ ...spawn });
    expect(retry).toEqual(first);
    await tick();
    expect(port.spawn).toHaveBeenCalledOnce();
    await expect(
      supervisor.spawn({ ...spawn, prompt: "changed" }),
    ).rejects.toMatchObject({ category: "conflict" });
  });

  it("deep-snapshots authority before asynchronous admission", async () => {
    let releaseLedger!: () => void;
    const ledgerGate = new Promise<void>((resolve) => {
      releaseLedger = resolve;
    });
    const worker = controlled();
    const spawn = spawnPacket("authority-snapshot");
    const supervisor = new WorkerSupervisor({
      port: {
        spawn: async (packet) => {
          expect(packet.authority.trustRevision).toBe("trust-1");
          expect(Object.isFrozen(packet.authority)).toBe(true);
          return worker.handle;
        },
      },
      ledger: { append: async () => ledgerGate },
      maxActive: 1,
    });

    const admitted = supervisor.spawn(spawn);
    (spawn.authority as { trustRevision: string }).trustRevision = "mutated";
    releaseLedger();
    await admitted;
    await tick();
  });
});
